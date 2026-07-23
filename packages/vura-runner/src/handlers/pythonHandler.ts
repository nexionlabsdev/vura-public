import * as path from 'path';
import { spawn } from 'child_process';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';
import { ContextManager } from '../services/contextManager';
import { runProcess } from '../utils/processRunner';
import { ensurePythonVenv } from '../utils/pythonVenv';
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

export async function handlePython(
    cell: FlownbCell,
    cellIndex: number,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    const pythonBin = await ensurePythonVenv(env, logger);

    const lines = cell.value.split('\n');
    const codeLines: string[] = [];

    for (const line of lines) {
        if (line.trim().startsWith('!pip')) {
            const args = line.trim().split(' ').filter(x => x.length > 0).slice(1);
            await runProcess(pythonBin, ['-m', 'pip', ...args], env.storagePath, logger, process.env, true);
        } else {
            codeLines.push(line);
        }
    }

    const code = codeLines.join('\n');

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
    const sidecarScript = path.join(env.storagePath, 'sidecar.py');

    // One warm worker per (notebook, interpreter) — a different venv gets its own
    // worker rather than reusing a process that imported a different Python.
    const poolKey = `${env.notebookId}:python:${pythonBin}`;
    const worker = await sidecarPool.acquire(poolKey, () => spawn(pythonBin, [sidecarScript, '--serve'], {
        cwd: env.notebookDir,
        env: { ...process.env, VURA_STORAGE_PATH: env.storagePath }
    }));

    try {
        const response = await sidecarPool.send(worker, {
            code,
            env: { VURA_DATAVERSE_TOKEN: activeToken, VURA_DEPTH_LIMIT: depthLimit.toString() }
        });

        // Pull the vura_bridge_mapping bookkeeping lines out of stderr before
        // displaying it — those are our own protocol markers, not cell output.
        const stderrLines = response.stderr.split('\n');
        const visibleStderrLines: string[] = [];
        for (const line of stderrLines) {
            try {
                const parsed = JSON.parse(line.trim());
                if (parsed?.type === 'vura_bridge_mapping') {
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
            throw new Error(response.error || 'Python cell execution failed');
        }
    } finally {
        sidecarPool.release(poolKey, worker);
    }
}
