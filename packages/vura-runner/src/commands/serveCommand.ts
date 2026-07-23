import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { CliEnvironment } from '../cliEnvironment';
import { VuraRunner } from '../runner';
import { FlownbCell, ICellLogger } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';
import { sidecarPool } from '../services/sidecarPool';
import express from 'express';
import { EventEmitter } from 'events';
import swaggerUi from 'swagger-ui-express';
import { generateSwaggerDoc } from './swaggerGenerator';

const eventBus = new EventEmitter();
const runQueue = new Map<string, Promise<any>>();

// Helper to send SSE events
function broadcastEvent(type: string, data: any) {
    eventBus.emit('event', { type, data: JSON.stringify(data) });
}

class HttpLogger implements ICellLogger {
    private htmlOutputs: string[] = [];
    private runId: string;
    private flowName: string;
    private cellIndex: number;
    
    public currentCellLogs: string[] = [];
    public currentCellOutputs: any[] = [];
    public allCellOutputs: any[][] = [];
    private maxLogSizeBytes: number;
    private currentSizeBytes: number = 0;

    constructor(runId: string, flowName: string, maxLogSizeMb: number) {
        this.runId = runId;
        this.flowName = flowName;
        this.cellIndex = 0;
        this.maxLogSizeBytes = maxLogSizeMb * 1024 * 1024;
    }

    setCellIndex(index: number) {
        this.cellIndex = index;
        this.currentCellLogs = [];
        this.currentCellOutputs = [];
        this.allCellOutputs[index] = this.currentCellOutputs;
        this.currentSizeBytes = 0;
    }

    private addOutputSize(size: number): boolean {
        if (this.currentSizeBytes + size > this.maxLogSizeBytes) {
            if (this.currentSizeBytes < this.maxLogSizeBytes) {
                this.currentCellLogs.push("[OUTPUT TRUNCATED DUE TO SIZE LIMIT]");
                this.currentSizeBytes = this.maxLogSizeBytes;
            }
            return false;
        }
        this.currentSizeBytes += size;
        return true;
    }

    async logText(text: string): Promise<void> { 
        broadcastEvent('log_added', { runId: this.runId, flow: this.flowName, cellIndex: this.cellIndex, message: text });
        if (this.addOutputSize(text.length)) {
            this.currentCellLogs.push(text);
        }
    }
    
    async logError(error: string | Error): Promise<void> { 
        const msg = error instanceof Error ? error.message : String(error);
        broadcastEvent('log_added', { runId: this.runId, flow: this.flowName, cellIndex: this.cellIndex, message: msg });
        if (this.addOutputSize(msg.length)) {
            this.currentCellLogs.push("ERROR: " + msg);
        }
    }

    async logHtml(html: string): Promise<void> { 
        this.htmlOutputs.push(html);
        if (this.addOutputSize(html.length)) {
            this.currentCellOutputs.push({ type: 'html', data: html });
        }
    }
    
    async logJson(json: any): Promise<void> {
        const str = JSON.stringify(json);
        if (this.addOutputSize(str.length)) {
            this.currentCellOutputs.push({ type: 'json', data: json });
        }
    }
    
    async logMultiple(items: { mime: string, data: any }[]): Promise<void> {
        for (const item of items) {
            if (item.mime === 'application/json') {
                await this.logJson(item.data);
            } else if (item.mime === 'application/vnd.vura.visual') {
                await this.logHtml(item.data);
            }
        }
    }
    
    async clearOutput(): Promise<void> { 
        this.htmlOutputs = []; 
        this.currentCellOutputs = [];
        this.currentSizeBytes = 0;
    }
    
    async replaceOutput(html: string): Promise<void> { 
        this.htmlOutputs = [html]; 
    }
    
    getAllHtml(): string { return this.htmlOutputs.join('\n'); }
}

async function logHistoryToDuckDb(env: CliEnvironment, runId: string, flow: string, status: string, duration: number | null) {
    try {
        const duckDb = await DuckDbManager.getInstance(env);
        await duckDb.runQuery(`CREATE TABLE IF NOT EXISTS execution_history (id VARCHAR, flow VARCHAR, status VARCHAR, timestamp TIMESTAMP, duration INTEGER)`);
        
        const timestamp = new Date().toISOString();
        await duckDb.runQuery(`INSERT INTO execution_history VALUES (?, ?, ?, ?, ?)`, [runId, flow, status, timestamp, duration]);
    } catch (e) {
        console.error('Failed to log history to DuckDB', e);
    }
}

async function logCellToDuckDb(env: CliEnvironment, runId: string, flow: string, cellIndex: number, status: string, duration: number, logs: string, outputs: string, error: string | null) {
    try {
        const duckDb = await DuckDbManager.getInstance(env);
        await duckDb.runQuery(`CREATE TABLE IF NOT EXISTS execution_cell_logs (run_id VARCHAR, flow VARCHAR, cell_index INTEGER, status VARCHAR, duration INTEGER, logs VARCHAR, outputs VARCHAR, error VARCHAR)`);
        
        await duckDb.runQuery(`INSERT INTO execution_cell_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [runId, flow, cellIndex, status, duration, logs, outputs, error]);
    } catch (e) {
        console.error('Failed to log cell to DuckDB', e);
    }
}

const EXECUTION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Notebook execution timed out after ${ms / 1000}s`)),
            ms
        );
        promise.then(
            result => { clearTimeout(timer); resolve(result); },
            err => { clearTimeout(timer); reject(err); }
        );
    });
}

export function startServer(port: number, dir: string, envPath?: string, maxLogSizeMb: number = 5) {
    const app = express();
    const notebooksDir = path.resolve(process.cwd(), dir);
    const env = new CliEnvironment(notebooksDir, envPath);

    app.use(express.json());
    
    // Serve static dashboard
    app.use('/', express.static(path.join(__dirname, '../assets/dashboard')));

    // Swagger API Docs
    app.get('/api-docs/swagger.json', async (req, res) => {
        try {
            const doc = await generateSwaggerDoc(notebooksDir);
            res.json(doc);
        } catch (err) {
            console.error('Failed to generate Swagger doc:', err);
            res.status(500).json({ error: 'Failed to generate documentation' });
        }
    });
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(undefined, {
        swaggerOptions: {
            url: '/api-docs/swagger.json'
        }
    }));

    // Endpoints
    app.get('/api/flows', async (req, res) => {
        try {
            const files = await fs.readdir(notebooksDir);
            const flows = [];
            for (const file of files) {
                if (file.endsWith('.flownb')) {
                    const content = await fs.readFile(path.join(notebooksDir, file), 'utf8');
                    const cells = yaml.parse(content) as FlownbCell[];
                    
                    let inputSchema = null;
                    let outputSchema = null;

                    for (const cell of cells) {
                        if (cell.language === 'http-input' && cell.value) {
                            try { inputSchema = JSON.parse(cell.value); } catch {}
                        }
                        if (cell.language === 'json' && cell.metadata?.vura_json_output && cell.value) {
                            try { outputSchema = JSON.parse(cell.value); } catch {}
                        }
                    }

                    flows.push({ name: file, inputSchema, outputSchema });
                }
            }
            res.json(flows);
        } catch (e) {
            res.status(500).json({ error: 'Failed to read flows' });
        }
    });

    app.get('/api/history', async (req, res) => {
        const flow = req.query.flow as string;
        try {
            const duckDb = await DuckDbManager.getInstance(env);
            await duckDb.runQuery(`CREATE TABLE IF NOT EXISTS execution_history (id VARCHAR, flow VARCHAR, status VARCHAR, timestamp TIMESTAMP, duration INTEGER)`);
            
            let query = `SELECT id, flow, arg_max(status, timestamp) as status, max(timestamp) as timestamp, max(duration) as duration FROM execution_history`;
            const params: any[] = [];
            if (flow) {
                query += ` WHERE flow = ?`;
                params.push(flow);
            }
            query += ` GROUP BY id, flow ORDER BY timestamp DESC LIMIT 50`;
            
            const records = await duckDb.runQuery(query, params);
            res.json(records);
        } catch (e) {
            res.status(500).json({ error: 'Failed to read history' });
        }
    });

    app.get('/api/history/:runId', async (req, res) => {
        try {
            const duckDb = await DuckDbManager.getInstance(env);
            
            // Get run info
            const runs = await duckDb.runQuery(`SELECT id, flow, arg_max(status, timestamp) as status, max(timestamp) as timestamp, max(duration) as duration FROM execution_history WHERE id = ? GROUP BY id, flow`, [req.params.runId]);
            if (!runs || runs.length === 0) return res.status(404).json({ error: 'Run not found' });
            
            // Get cells
            let cells = [];
            try {
                cells = await duckDb.runQuery(`SELECT * FROM execution_cell_logs WHERE run_id = ? ORDER BY cell_index ASC`, [req.params.runId]);
            } catch (e) {
                // Table might not exist if no cells ran yet
            }

            res.json({ run: runs[0], cells });
        } catch (e) {
            res.status(500).json({ error: 'Failed to read run details' });
        }
    });

    app.get('/api/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const listener = (event: { type: string, data: string }) => {
            res.write(`event: ${event.type}\n`);
            res.write(`data: ${event.data}\n\n`);
        };

        eventBus.on('event', listener);
        req.on('close', () => eventBus.removeListener('event', listener));
    });

    app.all('/flow/trigger/:notebookFile', async (req, res) => {
        const notebookFile = req.params.notebookFile;
        if (!/^[a-zA-Z0-9._-]+$/.test(notebookFile)) {
            return res.status(400).json({ error: 'Invalid notebook file name' });
        }
        if (!notebookFile.endsWith('.flownb')) {
            return res.status(400).json({ error: 'Notebook file must end with .flownb' });
        }

        const fullPath = path.join(notebooksDir, notebookFile);
        try { await fs.access(fullPath); } catch {
            return res.status(404).json({ error: "Notebook " + notebookFile + " not found in " + notebooksDir });
        }

        const runId = Math.random().toString(36).substring(2, 9);
        const startTime = Date.now();

        const executeRun = async () => {
            broadcastEvent('run_started', { id: runId, flow: notebookFile });
            await logHistoryToDuckDb(env, runId, notebookFile, 'running', null);

            const httpRequestContext = { query: req.query, body: req.body || {}, headers: req.headers, method: req.method };
            let isolatedDuckDb: DuckDbManager | null = null;

            try {
                isolatedDuckDb = await DuckDbManager.createIsolated();
                const requestEnv = Object.create(env);

                const content = await fs.readFile(fullPath, 'utf8');
                const cells = yaml.parse(content) as FlownbCell[];

                const runner = new VuraRunner(requestEnv, isolatedDuckDb);
                const logger = new HttpLogger(runId, notebookFile, maxLogSizeMb);

                await runner.injectHttpRequest(httpRequestContext, logger);

            let finalResponse: any = null;

            const execResult = await withTimeout(runner.executeNotebook(cells, logger, process.env as any, {
                onCellStart: (i, total) => {
                    broadcastEvent('cell_started', { runId, flow: notebookFile, cellIndex: i, totalCells: total });
                    logger.setCellIndex(i);
                },
                onCellEnd: (i, result) => {
                    // Log to DuckDB asynchronously is fine, but we'll await it to ensure order
                    // Since the callback is sync in interface, we do a fire-and-forget promise for logging
                    // Wait, the interface is sync, so we just call it and it returns void.
                    // Actually, let's make the hooks async or just fire-and-forget here
                    const cellError = result.error;
                    const cellStatus = result.status;
                    const cellDuration = result.durationMs;
                    // Fire and forget DuckDB logging
                    logCellToDuckDb(env, runId, notebookFile, i, cellStatus, cellDuration, JSON.stringify(logger.currentCellLogs), JSON.stringify(logger.currentCellOutputs), cellError).catch(() => {});
                }
            }), EXECUTION_TIMEOUT_MS);

            if (execResult.httpOutputCell) {
                const cell = execResult.httpOutputCell;
                if (cell.language === 'json' && cell.metadata?.vura_json_output) {
                    try {
                        let rawOutput = typeof cell.metadata.vura_json_output === 'string' ? cell.metadata.vura_json_output : JSON.stringify(cell.metadata.vura_json_output);
                        rawOutput = rawOutput.replace(/"\$VISUAL_OUTPUT_(\d+)"/g, (match: string, p1: string) => {
                            const targetIdx = parseInt(p1, 10) - 1;
                            const outputs = logger.allCellOutputs[targetIdx] || [];
                            const htmls = outputs.filter((o: any) => o.type === 'html').map((o: any) => o.data);
                            return JSON.stringify(htmls.join('\n'));
                        });
                        if (rawOutput.includes('"$VISUAL_OUTPUT"')) {
                            rawOutput = rawOutput.replace('"$VISUAL_OUTPUT"', JSON.stringify(logger.getAllHtml()));
                        }
                        const parsedOutput = JSON.parse(rawOutput);
                        if (parsedOutput && typeof parsedOutput === 'object' && 
                           (parsedOutput.hasOwnProperty('$body') || parsedOutput.hasOwnProperty('$headers'))) {
                            finalResponse = parsedOutput;
                        }
                    } catch (e) {}
                } else {
                    const boundary = 'vura_boundary_' + Date.now();
                    const parts: string[] = [];
                    // Using the logger outputs for the http output cell's index
                    const outputs = execResult.httpOutputCellIndex !== null ? (logger.allCellOutputs[execResult.httpOutputCellIndex] || []) : [];
                    
                    for (let idx = 0; idx < outputs.length; idx++) {
                        const out = outputs[idx];
                        if (out.type === 'json') {
                            parts.push(`--${boundary}\r\nContent-Type: application/json\r\nContent-Disposition: attachment; filename="output_${idx}.json"\r\n\r\n${JSON.stringify(out.data, null, 2)}\r\n`);
                        } else if (out.type === 'html') {
                            parts.push(`--${boundary}\r\nContent-Type: text/html\r\nContent-Disposition: attachment; filename="output_${idx}.html"\r\n\r\n${out.data}\r\n`);
                        }
                    }
                    parts.push(`--${boundary}--`);
                    
                    finalResponse = {
                        $headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
                        $rawBody: parts.join('')
                    };
                }
            }

            const duration = Date.now() - startTime;
            if (execResult.status === 'error') {
                broadcastEvent('run_failed', { runId, flow: notebookFile, error: execResult.error });
                await logHistoryToDuckDb(env, runId, notebookFile, 'error', duration);
            } else {
                broadcastEvent('run_completed', { runId, flow: notebookFile, duration });
                await logHistoryToDuckDb(env, runId, notebookFile, 'success', duration);
            }

            if (finalResponse) {
                if (finalResponse.$headers) res.set(finalResponse.$headers);
                const statusCode = execResult.status === 'error' ? 500 : 200;
                
                if (finalResponse.$rawBody !== undefined) {
                    return res.status(statusCode).send(finalResponse.$rawBody);
                }
                let body = finalResponse.$body;
                if (typeof body === 'object') return res.status(statusCode).json(body);
                else return res.status(statusCode).send(body);
            }

            if (execResult.status === 'error') {
                return res.status(500).json({ error: execResult.error });
            }
            return res.json({ success: true, message: 'Flow executed successfully' });

        } catch (err: any) {
            const duration = Date.now() - startTime;
            const errMsg = err.message || 'Execution failed';
            console.error('Flow Execution Error:', err);
            
            broadcastEvent('run_failed', { runId, flow: notebookFile, error: errMsg });
            await logHistoryToDuckDb(env, runId, notebookFile, 'error', duration);
            
            return res.status(500).json({ error: errMsg });
        } finally {
            if (isolatedDuckDb) {
                isolatedDuckDb.dispose();
            }
        }
        };

        // Chain onto the existing run for this notebook, then reset to a flat resolved promise
        // so the chain never grows longer than one pending run.
        const prev = runQueue.get(notebookFile) ?? Promise.resolve();
        const next = prev.then(() => executeRun()).finally(() => {
            if (runQueue.get(notebookFile) === next) runQueue.set(notebookFile, Promise.resolve());
        });
        runQueue.set(notebookFile, next);
    });

    const server = app.listen(port, () => {
        console.log("VURA API Server listening on port " + port);
        console.log("Serving notebooks from " + notebooksDir);
        console.log("Dashboard available at http://localhost:" + port + "/");
    });

    // Warm sidecar workers persist across requests (that's the point of the pool) —
    // only reap them on an actual shutdown, not per-request.
    const shutdown = () => {
        sidecarPool.disposeAll();
        server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
