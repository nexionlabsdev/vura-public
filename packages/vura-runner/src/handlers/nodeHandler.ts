import * as path from 'path';
import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';
import { ContextManager } from '../services/contextManager';
import { runProcess } from '../utils/processRunner';
import { sidecarPool } from '../services/sidecarPool';

function buildVegaLiteHtml(spec: any): string {
    return `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
  <script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
  <script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
</head>
<body>
  <div id="vis"></div>
  <script>vegaEmbed('#vis', ${JSON.stringify(spec)});</script>
</body>
</html>`;
}

function transformImports(code: string): string {
    if (typeof code !== 'string') return code;
    return code
        .replace(/^(\s*)import\s+(\*\s+as\s+\w+)\s+from\s+(['"][^'"]+['"])\s*;?/gm, '$1const $2 = require($3);')
        .replace(/^(\s*)import\s+([\w$]+)\s*,\s*(\{[\s\S]*?\})\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, defaultImport, namedImports, mod) => {
            const destructured = namedImports.slice(1, -1).split(',').map((s: string) => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
            }).filter(Boolean).join(', ');
            return `${indent}const _default_${defaultImport} = require(${mod}); const ${defaultImport} = _default_${defaultImport}.default || _default_${defaultImport}; const { ${destructured} } = require(${mod});`;
        })
        .replace(/^(\s*)import\s+(\{[\s\S]*?\})\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, clause, mod) => {
            const destructured = clause.slice(1, -1).split(',').map((s: string) => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
            }).filter(Boolean).join(', ');
            return `${indent}const { ${destructured} } = require(${mod});`;
        })
        .replace(/^(\s*)import\s+([\w$]+)\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, defaultImport, mod) => {
            return `${indent}const _default_${defaultImport} = require(${mod}); const ${defaultImport} = _default_${defaultImport}.default || _default_${defaultImport};`;
        })
        .replace(/^(\s*)import\s+(['"][^'"]+['"])\s*;?/gm, '$1require($2);');
}

export async function handleNode(
    cell: FlownbCell,
    cellIndex: number,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const lines = cell.value.split('\n');
    const codeLines: string[] = [];

    for (const line of lines) {
        if (line.trim().startsWith('!npm install') || line.trim().startsWith('!npm i')) {
            const args = line.trim().split(' ').slice(1);
            await runProcess(npmCmd, ['install', ...args], env.storagePath, logger, process.env, true);
        } else {
            codeLines.push(line);
        }
    }

    let code = codeLines.join('\n');
    code = transformImports(code);
    try {
        const transformResult = esbuild.transformSync(code, { loader: 'ts', target: 'node18' });
        code = transformResult.code;
    } catch { }

    // Synthetic __filename/__dirname for the cell — no temp file is written to
    // disk anymore, the code goes straight to the warm worker over stdin.
    const cellFilename = path.join(env.notebookDir, `cell_${cellIndex}.js`);

    const sidecarScript = path.join(env.storagePath, 'sidecar.js');
    let activeToken = '';
    const connectionId = cell.metadata?.connectionId;
    if (connectionId && connectionId !== 'local') {
        try {
            const secretPayload = await env.getProfileSecret(connectionId);
            if (secretPayload) {
                activeToken = (JSON.parse(secretPayload).token) || '';
            }
        } catch { }
    }

    const depthLimit = env.getConfig<number>('vura.depthLimit', 5);
    const poolKey = `${env.notebookId}:node`;
    const nodeBin = process.execPath || 'node';
    const extraNodePaths = [
        ...(module.paths || []),
        path.join(__dirname, '..', '..', 'node_modules'),
        path.join(__dirname, '..', '..', '..', 'node_modules'),
        process.env.NODE_PATH
    ].filter(Boolean).join(path.delimiter);

    const maxOldSpaceSizeMb = env.getConfig<number>('vura.node.maxOldSpaceSizeMb', 512);
    const nodeArgs = [sidecarScript, '--serve'];
    if (maxOldSpaceSizeMb && maxOldSpaceSizeMb > 0) {
        nodeArgs.unshift(`--max-old-space-size=${maxOldSpaceSizeMb}`);
    }

    const worker = await sidecarPool.acquire(poolKey, () => spawn(nodeBin, nodeArgs, {
        cwd: env.notebookDir,
        env: { ...process.env, VURA_STORAGE_PATH: env.storagePath, NODE_PATH: extraNodePaths },
        windowsHide: true
    }));

    try {
        const response = await sidecarPool.send(worker, {
            code,
            filename: cellFilename,
            ctx: { storagePath: env.storagePath, token: activeToken, depthLimit }
        });

        // Pull the vura_bridge_mapping bookkeeping lines out of stderr before
        // displaying it — those are our own protocol markers, not cell output.
        const stderrLines = response.stderr.split('\n');
        const visibleStderrLines: string[] = [];
        for (const line of stderrLines) {
            try {
                const parsed = JSON.parse(line.trim());
                if (parsed?.type === 'vura_io_mapping' || parsed?.type === 'vura_bridge_mapping') {
                    await ContextManager.getInstance().setMapping(env, parsed.variable, parsed.path);
                    continue;
                }
            } catch { }
            visibleStderrLines.push(line);
        }
        const visibleStderr = visibleStderrLines.join('\n').trim();

        if (response.stdout) await logger.logText(response.stdout);
        if (visibleStderr) await logger.logText(visibleStderr);

        if (response.stdout.trim()) {
            try {
                const parsed = JSON.parse(response.stdout.trim());
                if (parsed?.type === 'graph' && parsed.spec) {
                    await logger.logMultiple([
                        { mime: 'application/vnd.vura.visual', data: buildVegaLiteHtml(parsed.spec) },
                        { mime: 'application/json', data: parsed }
                    ]);
                }
            } catch { }
        }

        if (response.status === 'error') {
            throw new Error(response.error || 'Node cell execution failed');
        }
    } finally {
        sidecarPool.release(poolKey, worker);
    }
}
