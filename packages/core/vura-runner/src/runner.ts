import * as path from 'path';
import * as fs from 'fs/promises';
import { SqlService } from './services/sqlService';
import { handleODataWriteback } from './handlers/writebackHandler';
import { handleTemplateExecution } from './handlers/templateHandler';
import { handleJsonCompose } from './handlers/jsonComposeHandler';
import { handleVegaGraph } from './handlers/vegaGraphHandler';
import { handleHttpInput } from './handlers/httpInputHandler';
import { handlePython } from './handlers/pythonHandler';
import { handleNode } from './handlers/nodeHandler';
import { handleTerminal } from './handlers/terminalHandler';
import { DuckDbManager } from './services/duckDbManager';
import { ExecutionContextManager } from './services/executionContextManager';
import { ConditionEvaluator } from './services/conditionEvaluator';
import { runProcess } from './utils/processRunner';
import { loadPlugins } from './pluginLoader';
import { ParquetUtilities } from '@vura-data-os/core-sdk';
import * as arrow from 'apache-arrow';
import { IVuraEnvironment, ICellLogger, FlownbCell, NotebookExecutionResult, CellExecutionResult } from './interfaces';

export async function prepareStorageWorkspace(env: IVuraEnvironment, logger?: ICellLogger): Promise<void> {
    if (!env.storagePath) {
        throw new Error("Storage path is required to run VURA.");
    }
    await fs.mkdir(env.storagePath, { recursive: true });

    const assets = ['sidecar.py', 'sidecar.js'];
    for (const asset of assets) {
        const source = path.join(__dirname, 'assets', asset);
        const target = path.join(env.storagePath, asset);
        try {
            await fs.copyFile(source, target);
        } catch (e) { }
    }

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const baseStorage = (env.notebookId && env.storagePath.includes(path.join('sessions', env.notebookId)))
        ? path.dirname(path.dirname(env.storagePath))
        : env.storagePath;

    await fs.mkdir(baseStorage, { recursive: true });
    const packageJsonPath = path.join(baseStorage, 'package.json');
    try {
        await fs.access(packageJsonPath);
    } catch {
        const dummyJson = JSON.stringify({ name: "vura-storage", private: true, dependencies: { "@duckdb/node-api": "*", "apache-arrow": "*" } });
        await fs.writeFile(packageJsonPath, dummyJson, 'utf8');
    }
}

export async function cleanNotebookSession(env: IVuraEnvironment): Promise<void> {
    const notebookId = env.notebookId || 'default';

    // 1. Dispose DuckDB instance
    DuckDbManager.disposeNotebook(notebookId);

    // 2. Dispose warm sidecar processes and wait for exit
    const { sidecarPool } = require('./services/sidecarPool');
    await sidecarPool.disposeNotebook(notebookId);

    // 3. Clear ContextManager mappings
    const { ContextManager } = require('./services/contextManager');
    ContextManager.getInstance().clearMappings(notebookId);

    // 4. Delete session files and directories
    if (env.storagePath) {
        try {
            const files = await fs.readdir(env.storagePath);
            for (const file of files) {
                const fullPath = path.join(env.storagePath, file);
                await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
            }
        } catch { }
    }
}

export interface VuraRunnerOptions {
    enableVisualOutputs?: boolean;
    schemaName?: string;
}

export class VuraRunner {
    private isStoragePrepared = false;
    private options: VuraRunnerOptions;

    constructor(private env: IVuraEnvironment, private _duckDbInstance?: DuckDbManager, options?: VuraRunnerOptions) {
        this.options = { enableVisualOutputs: true, ...options };
    }

    private async _getDuckDb(): Promise<DuckDbManager> {
        return this._duckDbInstance ?? DuckDbManager.getInstance(this.env);
    }

    public async executeCell(
        cell: FlownbCell,
        cellIndex: number,
        notebookCells: FlownbCell[],
        logger: ICellLogger
    ): Promise<void> {
        try {
            await this.prepareStorage(logger);

            switch (cell.language) {
                case 'python':
                    await handlePython(cell, cellIndex, this.env, logger);
                    break;
                case 'javascript':
                    await handleNode(cell, cellIndex, this.env, logger);
                    break;
                case 'sql':
                    await this.executeSql(cell, cellIndex, logger);
                    break;
                case 'html':
                    await handleTemplateExecution(cell.value, cell.metadata?.templateContextTable, this.env, logger);
                    break;
                case 'shellscript':
                case 'vura-terminal':
                    await handleTerminal(cell, this.env, logger);
                    break;
                case 'vega-lite':
                    await handleVegaGraph(
                        cell.value,
                        cell.metadata?.graphSourceCell,
                        cell.metadata?.graphDataPath,
                        notebookCells,
                        this.env,
                        logger,
                        await this._getDuckDb(),
                        cell.metadata?.graphSourceCellName
                    );
                    break;
                case 'json':
                    const serialized = await handleJsonCompose(cell.value, logger, await this._getDuckDb());
                    if (!cell.metadata) cell.metadata = {};
                    cell.metadata.vura_json_output = serialized;
                    break;
                case 'http-input':
                    await handleHttpInput(cell.value, this.env, logger, await this._getDuckDb());
                    break;
                default:
                    throw new Error(`Unsupported cell language: "${cell.language}".`);
            }
        } catch (err: any) {
            await logger.logError(err);
            throw err;
        }
    }

    public async injectHttpRequest(requestData: any, logger: ICellLogger) {
        await this.prepareStorage(logger);

        const reqJsonPath = path.join(this.env.storagePath, 'http_request.json');
        const reqObj = {
            query: {},
            body: {},
            headers: {},
            method: 'GET',
            ...(requestData || {})
        };
        await fs.writeFile(reqJsonPath, JSON.stringify([reqObj]), 'utf8');

        const duckDb = await this._getDuckDb();
        try { await duckDb.runQuery(`DROP VIEW IF EXISTS http_request`); } catch { }
        try { await duckDb.runQuery(`DROP TABLE IF EXISTS http_request`); } catch { }

        // Create or replace DuckDB table using read_json_auto so query, body, headers are STRUCTs
        await this.executeSql({
            language: 'sql',
            value: `CREATE TABLE http_request AS SELECT * FROM read_json_auto('${reqJsonPath.replace(/\\/g, '/')}');`,
            kind: 2
        }, -1, logger);
    }

    private async prepareStorage(logger: ICellLogger) {
        if (this.isStoragePrepared) return;
        await prepareStorageWorkspace(this.env, logger);
        this.isStoragePrepared = true;
    }

    public static async runProcess(
        cmd: string,
        args: string[],
        cwd: string,
        logger?: ICellLogger,
        env?: any,
        streamOutputs = false
    ): Promise<{ stdout: string; stderr: string }> {
        return runProcess(cmd, args, cwd, logger, env, streamOutputs);
    }

    private async executeSql(cell: FlownbCell, cellIndex: number, logger: ICellLogger) {
        const textLines = cell.value.split('\n');
        let shouldExecuteQuery = true;

        for (const line of textLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('-- !odata-push')) {
                const match = trimmed.match(/--\s+!odata-push\s+(insert|update|delete)\s+([^\s]+)\s+->\s+([^\s]+)/);
                if (match) {
                    await handleODataWriteback(cell.metadata?.connectionId, match[1], match[2], match[3], this.env, logger);
                    shouldExecuteQuery = false;
                }
            }
        }

        if (!shouldExecuteQuery) {
            return;
        }

        const query = cell.value;
        const connectionId = cell.metadata?.connectionId;
        const tableName = cell.metadata?.tableName || `cell_${cellIndex}`;
        // Helper to safely split SQL statements ignoring semicolons inside strings/comments
        const splitSqlStatements = (sql: string): string[] => {
            const statements: string[] = [];
            let current = '';
            let inString = false;
            let stringChar = '';
            let inComment = false;

            for (let i = 0; i < sql.length; i++) {
                const char = sql[i];
                if (inComment) {
                    current += char;
                    if (char === '\n') inComment = false;
                    continue;
                }
                if (!inString && char === '-' && sql[i + 1] === '-') {
                    inComment = true;
                    current += char;
                    continue;
                }
                if (!inString && (char === "'" || char === '"')) {
                    inString = true;
                    stringChar = char;
                    current += char;
                } else if (inString && char === stringChar) {
                    if (i + 1 < sql.length && sql[i + 1] === stringChar) {
                        current += char + stringChar;
                        i++;
                    } else {
                        inString = false;
                        current += char;
                    }
                } else if (!inString && char === ';') {
                    if (current.trim().length > 0) statements.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            if (current.trim().length > 0) statements.push(current.trim());
            return statements;
        };

        const statements = splitSqlStatements(query);
        const duckDb = await this._getDuckDb();
        await duckDb.syncStorageViews(this.env);
        let statementIndex = 1;

        for (const statement of statements) {
            if (!statement) continue;

            const currentTableName = statementIndex === 1 ? tableName : `${tableName}_${statementIndex}`;
            let records: any[] = [];

            if (connectionId && connectionId !== 'local') {
                const activeProfile = await this.env.getProfile(connectionId);
                if (!activeProfile) throw new Error(`Connection profile ${connectionId} not found.`);

                const secretPayload = await this.env.getProfileSecret(activeProfile.id);
                const sqlService = new SqlService(activeProfile, secretPayload);

                records = await sqlService.executeSql(statement, logger);

                if (records && records.length > 0) {
                    const table = arrow.tableFromJSON(records);
                    const recordBatchStream = arrow.RecordBatchStreamWriter.writeAll(table);
                    const chunks = [];
                    for await (const chunk of recordBatchStream) {
                        chunks.push(chunk);
                    }
                    const buffer = Buffer.concat(chunks);
                    await duckDb.saveTableArrowIPC(currentTableName, buffer);
                    try {
                        await duckDb.exportTableToParquet(currentTableName, this.env.storagePath);
                    } catch { }
                }
            } else {
                const createMatch = statement.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:"([^"]+)"|([a-zA-Z0-9_]+))/i);
                let targetName: string | null = null;
                if (createMatch) {
                    targetName = createMatch[1] || createMatch[2];
                    if (targetName) {
                        try { await duckDb.runQuery(`DROP VIEW IF EXISTS "${targetName}"`); } catch { }
                        try { await duckDb.runQuery(`DROP TABLE IF EXISTS "${targetName}"`); } catch { }
                    }
                }
                records = await duckDb.runQuery(statement);
                if (statement.trim().toUpperCase().startsWith("SELECT")) {
                    // Guard each drop independently: DuckDB's IF EXISTS doesn't suppress
                    // catalog type-mismatch errors, so a stale object of the opposite type
                    // left over from a previous run must not block the CREATE TABLE below.
                    try { await duckDb.runQuery(`DROP VIEW IF EXISTS "${currentTableName}"`); } catch { }
                    try { await duckDb.runQuery(`DROP TABLE IF EXISTS "${currentTableName}"`); } catch { }
                    try {
                        await duckDb.runQuery(`CREATE TABLE "${currentTableName}" AS ${statement}`);
                    } catch(e) { }
                    targetName = currentTableName;
                }
                if (targetName) {
                    try {
                        await duckDb.exportTableToParquet(targetName, this.env.storagePath);
                    } catch { }
                }
            }

            if (records && records.length > 0) {
                const safeRecords = records.map((row: any) => {
                    const out: any = {};
                    for (const [k, v] of Object.entries(row)) {
                        if (typeof v === 'bigint') {
                            out[k] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
                                ? Number(v) : v.toString();
                        } else {
                            out[k] = v;
                        }
                    }
                    return out;
                });
                const outputs: { mime: string; data: any }[] = [
                    { mime: 'application/json', data: safeRecords }
                ];
                if (this.options.enableVisualOutputs !== false) {
                    outputs.unshift({ mime: 'application/vnd.vura.visual', data: this._getGridHtml(safeRecords) });
                }
                await logger.logMultiple(outputs);
                statementIndex++;
            } else if (statements.length === 1) {
                await logger.logText('Query executed successfully. No records returned.');
            }

            // Persist row count onto the cell for runWhen condition evaluation (last statement wins)
            if (!cell.metadata) cell.metadata = {};
            cell.metadata._lastRowCount = records?.length ?? 0;
        }
    }

    private _getGridHtml(data: any[]): string {
        if (!data || data.length === 0) {
            return '<div style="padding:8px;font-family:var(--vscode-font-family,monospace);font-size:12px">No data returned</div>';
        }

        const PAGE_SIZE = 100;
        const totalRows = data.length;
        const keys = Object.keys(data[0]);

        const firstPage = data.slice(0, PAGE_SIZE);
        const headerHtml = keys.map(k => `<th>${this._escapeHtml(k)}</th>`).join('');
        const bodyHtml = firstPage.map(row =>
            '<tr>' + keys.map(k => {
                const v = row[k];
                if (v === null || v === undefined) return '<td class="vura-null">null</td>';
                if (typeof v === 'object') return `<td>${this._escapeHtml(JSON.stringify(v))}</td>`;
                return `<td>${this._escapeHtml(String(v))}</td>`;
            }).join('') + '</tr>'
        ).join('');

        const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
        const footerLabel = totalRows > PAGE_SIZE
            ? `Showing rows 1-${firstPage.length} of ${totalRows}`
            : `${totalRows} row${totalRows !== 1 ? 's' : ''}`;

        const embedData = data.length > 500 ? data.slice(0, 500) : data;
        const jsonData = JSON.stringify(embedData, (k, v) => (typeof v === 'bigint' ? Number(v) : v))
            .replace(/&/g, '\\u0026')
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .split('\u2028').join('\\u2028')
            .split('\u2029').join('\\u2029');

        return `<style>
  .vg { font-family:var(--vscode-font-family,monospace); font-size:12px; color:var(--vscode-editor-foreground); }
  .vg-bar { display:flex; align-items:center; gap:8px; padding:4px 8px; flex-wrap:wrap;
    border-bottom:1px solid var(--vscode-panel-border);
    background:var(--vscode-editor-inactiveSelectionBackground); }
  .vg-bar input { background:var(--vscode-input-background); color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border,#555); padding:2px 6px; font-size:12px;
    border-radius:2px; width:160px; outline:none; }
  .vg-info { flex:1; font-size:11px; color:var(--vscode-descriptionForeground); }
  .vg-pg { display:flex; align-items:center; gap:3px; }
  .vg-pg button { background:var(--vscode-button-secondaryBackground,#3a3d41);
    color:var(--vscode-button-secondaryForeground,#ccc);
    border:none; padding:1px 8px; cursor:pointer; border-radius:2px; font-size:12px; }
  .vg-pg button:disabled { opacity:0.35; cursor:default; }
  .vg-pg span { font-size:11px; color:var(--vscode-descriptionForeground); min-width:55px; text-align:center; }
  .vg-wrap { overflow:auto; max-height:380px; }
  .vg table { border-collapse:collapse; width:100%; }
  .vg th { background:var(--vscode-editor-inactiveSelectionBackground);
    border:1px solid var(--vscode-panel-border); padding:4px 10px;
    text-align:left; position:sticky; top:0; font-weight:600; white-space:nowrap; z-index:1; }
  .vg td { border:1px solid var(--vscode-panel-border); padding:3px 10px;
    white-space:nowrap; max-width:300px; overflow:hidden; text-overflow:ellipsis; }
  .vg tr:nth-child(even) td { background:rgba(128,128,128,0.06); }
  .vg tr:hover td { background:var(--vscode-list-hoverBackground); }
  .vura-null { color:var(--vscode-disabledForeground); font-style:italic; }
</style>
<div class="vg">
  <div class="vg-bar">
    <input class="vg-search" placeholder="Search..."/>
    <span class="vg-info">${footerLabel}</span>
    <div class="vg-pg">
      <button class="vg-first">&#171;</button>
      <button class="vg-prev">&#8249;</button>
      <span class="vg-pagelabel">1 / ${totalPages}</span>
      <button class="vg-next">&#8250;</button>
      <button class="vg-last">&#187;</button>
    </div>
  </div>
  <div class="vg-wrap">
    <table>
      <thead><tr>${headerHtml}</tr></thead>
      <tbody class="vg-body">${bodyHtml}</tbody>
    </table>
  </div>
</div>
<script>
(function(){
  // Scoped to this output's own container (document.currentScript's preceding
  // sibling) instead of shared ids/window.* globals — with more than one grid
  // output in the notebook's webview document, those previously collided
  // (every grid used the same ids and clobbered the same window.vgFilter/vgGo
  // functions), so running one cell could repaint another cell's table.
  var root = document.currentScript.previousElementSibling;
  if (!root) return;
  var PS=${PAGE_SIZE}, TOTAL=${totalRows}, ALL=${jsonData};
  var KEYS=${JSON.stringify(keys)};
  var fil=ALL, page=0;

  var searchEl=root.querySelector('.vg-search');
  var infoEl=root.querySelector('.vg-info');
  var bodyEl=root.querySelector('.vg-body');
  var pageLabelEl=root.querySelector('.vg-pagelabel');
  var firstBtn=root.querySelector('.vg-first');
  var prevBtn=root.querySelector('.vg-prev');
  var nextBtn=root.querySelector('.vg-next');
  var lastBtn=root.querySelector('.vg-last');

  function totalPages(){ return Math.max(1,Math.ceil(fil.length/PS)); }
  function esc(v){
    if(v===null||v===undefined) return '<span class="vura-null">null</span>';
    return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function render(){
    var s=page*PS, rows=fil.slice(s,s+PS);
    bodyEl.innerHTML=rows.map(function(row){
      return '<tr>'+KEYS.map(function(k){
        var v=row[k];
        return '<td>'+(v===null||v===undefined?'<span class="vura-null">null</span>':
          (typeof v==='object'?esc(JSON.stringify(v)):esc(String(v))))+'</td>';
      }).join('')+'</tr>';
    }).join('');
    var tp=totalPages();
    pageLabelEl.textContent=(page+1)+' / '+tp;
    infoEl.textContent = fil.length<TOTAL?(fil.length+' of '+TOTAL+' rows'):(TOTAL+' rows');
    prevBtn.disabled=(page===0);
    nextBtn.disabled=(page>=tp-1);
  }
  function goTo(n){
    page=Math.max(0,Math.min(n,totalPages()-1));
    render();
  }

  searchEl.addEventListener('input', function(){
    var q=searchEl.value.toLowerCase();
    fil=q?ALL.filter(function(r){
      return Object.values(r).some(function(v){ return v!=null&&String(v).toLowerCase().indexOf(q)!==-1; });
    }):ALL;
    page=0; render();
  });
  firstBtn.addEventListener('click', function(){ goTo(0); });
  prevBtn.addEventListener('click', function(){ goTo(page-1); });
  nextBtn.addEventListener('click', function(){ goTo(page+1); });
  lastBtn.addEventListener('click', function(){ goTo(totalPages()-1); });

  render();
})();
</script>`;
    }

    private _escapeHtml(unsafe: string): string {
        if (unsafe === undefined || unsafe === null) return "";
        return unsafe.toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    public async executeNotebook(
        cells: FlownbCell[],
        logger: ICellLogger,
        envVars?: Record<string, string>,
        hooks?: {
            onCellStart?: (cellIndex: number, totalCells: number) => void;
            onCellEnd?: (cellIndex: number, result: CellExecutionResult) => void;
        },
        requiredPlugins?: string[]
    ): Promise<NotebookExecutionResult> {
        // Load Add-on plugins declared by the notebook itself (requiredPlugins) plus
        // whatever the global `vura.plugins` config lists, so magic commands like
        // !sync_dataverse resolve to a registered provider instead of falling through to
        // a raw (and unsafe) shell command.
        // `vura-runner config set` stores values as raw strings (the CLI's config
        // store has no schema), so a JSON array passed on the command line comes
        // back as a JSON-encoded string here rather than a real array — parse it
        // defensively rather than assuming the shape.
        const rawConfiguredPlugins = this.env.getConfig<string[] | string>('vura.plugins', []);
        let configuredPlugins: string[];
        if (Array.isArray(rawConfiguredPlugins)) {
            configuredPlugins = rawConfiguredPlugins;
        } else if (typeof rawConfiguredPlugins === 'string' && rawConfiguredPlugins.trim()) {
            try {
                const parsed = JSON.parse(rawConfiguredPlugins);
                configuredPlugins = Array.isArray(parsed) ? parsed : [rawConfiguredPlugins];
            } catch {
                configuredPlugins = [rawConfiguredPlugins];
            }
        } else {
            configuredPlugins = [];
        }
        const pluginNames = Array.from(new Set([...(requiredPlugins ?? []), ...configuredPlugins]));
        if (pluginNames.length > 0) {
            await loadPlugins(pluginNames, this.env, logger);
        }

        const ctxManager = new ExecutionContextManager(envVars ?? {});
        const evaluator = new ConditionEvaluator();
        const abortedGroups = new Set<string>();
        let firstError: string | null = null;
        let httpOutputCell: FlownbCell | null = null;
        let httpOutputCellIndex: number | null = null;

        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell.kind !== 2) continue;  // skip markup cells

            // Track http output cell regardless of execution path
            if (cell.metadata?.vura_is_http_output) {
                httpOutputCell = cell;
                httpOutputCellIndex = i;
            }

            const group = cell.metadata?.group as string | undefined;
            const label = cell.metadata?.label as string | undefined;
            const runWhen = cell.metadata?.runWhen as string | undefined;
            const context = ctxManager.getContext();

            // Evaluate runWhen condition — capture warnings so they appear in cell output
            let evalWarning: string | undefined;
            const shouldRun = evaluator.evaluate(runWhen, context, (msg) => { evalWarning = msg; });
            if (!shouldRun) {
                const result: CellExecutionResult = { status: 'skipped', rowCount: null, durationMs: 0, output: null, error: null };
                ctxManager.recordCell(i, label, group, result);
                // A cell skipped by its own runWhen aborts its group — downstream cells without
                // their own runWhen should not run against incomplete state.
                if (group) abortedGroups.add(group);
                if (hooks?.onCellEnd) hooks.onCellEnd(i, result);
                continue;
            }

            // Group abort: if this cell's group has been aborted, skip it
            // UNLESS it has an explicit runWhen that passed (runWhen overrides group abort)
            if (group && abortedGroups.has(group) && !runWhen) {
                const result: CellExecutionResult = { status: 'skipped', rowCount: null, durationMs: 0, output: null, error: null };
                ctxManager.recordCell(i, label, group, result);
                if (hooks?.onCellEnd) hooks.onCellEnd(i, result);
                continue;
            }

            if (hooks?.onCellStart) hooks.onCellStart(i, cells.length);

            // Surface condition evaluation warnings in the cell output (not silently in console only)
            if (evalWarning) await logger.logText(`⚠ ${evalWarning}`);

            const startTime = Date.now();
            let result: CellExecutionResult;
            try {
                await this.executeCell(cell, i, cells, logger);
                const rowCount = this._extractRowCount(cell);
                const output = this._extractJsonOutput(cell);
                result = { status: 'success', rowCount, durationMs: Date.now() - startTime, output, error: null };
                ctxManager.recordCell(i, label, group, result);
            } catch (err: any) {
                const msg = err.message || String(err);
                if (!firstError) firstError = msg;
                result = { status: 'error', rowCount: null, durationMs: Date.now() - startTime, output: null, error: msg };
                ctxManager.recordCell(i, label, group, result);
                // Abort subsequent cells in this group (if the cell belongs to one)
                if (group) abortedGroups.add(group);
            }

            if (hooks?.onCellEnd) hooks.onCellEnd(i, result);

            // After recording: if this cell is the http output cell, stop iterating
            if (cell.metadata?.vura_is_http_output) break;
        }

        return {
            status: firstError ? 'error' : 'success',
            context: ctxManager.getContext(),
            httpOutputCell,
            httpOutputCellIndex,
            error: firstError
        };
    }

    private _extractRowCount(cell: FlownbCell): number | null {
        if (typeof cell.metadata?._lastRowCount === 'number') return cell.metadata._lastRowCount;
        return null;
    }

    private _extractJsonOutput(cell: FlownbCell): any {
        if (cell.language === 'json' && cell.metadata?.vura_json_output) {
            try {
                if (typeof cell.metadata.vura_json_output === 'string') {
                    return JSON.parse(cell.metadata.vura_json_output);
                }
                return cell.metadata.vura_json_output;
            } catch {
                return null;
            }
        }
        return null;
    }
}
