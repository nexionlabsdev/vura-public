import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import Ajv from 'ajv';
import { sidecarPool } from '../services/sidecarPool';

describe('Phase 2 - Sidecar Protocol Fixes', () => {
    let tempDir: string;
    let ajv: Ajv;
    let validateRequest: any;
    let validateResponse: any;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-phase2-test-'));
        const assetsDir = path.join(__dirname, '..', 'assets');
        await fs.copyFile(path.join(assetsDir, 'sidecar.js'), path.join(tempDir, 'sidecar.js'));
        await fs.copyFile(path.join(assetsDir, 'sidecar.py'), path.join(tempDir, 'sidecar.py'));

        ajv = new Ajv();
        const rootDir = path.join(__dirname, '..', '..', '..', '..');
        const reqSchema = JSON.parse(await fs.readFile(path.join(rootDir, 'schemas', 'sidecar-request.schema.json'), 'utf-8'));
        const respSchema = JSON.parse(await fs.readFile(path.join(rootDir, 'schemas', 'sidecar-response.schema.json'), 'utf-8'));

        validateRequest = ajv.compile(reqSchema);
        validateResponse = ajv.compile(respSchema);
    });

    afterAll(async () => {
        sidecarPool.disposeAll();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('2a. Validates sidecar request and response schemas', () => {
        const validReq = {
            id: 'req-1',
            code: 'console.log("hello")',
            filename: 'cell.js',
            ctx: { token: 'abc', depthLimit: 5 }
        };
        expect(validateRequest(validReq)).toBe(true);

        const invalidReqWithEnv = {
            id: 'req-2',
            code: 'console.log("hello")',
            env: { VURA_DATAVERSE_TOKEN: 'abc' }
        };
        expect(validateRequest(invalidReqWithEnv)).toBe(false);

        const validResp = {
            id: 'req-1',
            status: 'ok',
            stdout: 'hello\n',
            stderr: ''
        };
        expect(validateResponse(validResp)).toBe(true);
    });

    it('2b. Context and token injection without env pollution in Node sidecar', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.js');
        const nodeBin = process.execPath || 'node';
        const nodeModulesPath = path.dirname(path.dirname(require.resolve('parquetjs-lite/package.json')));

        const worker = spawn(nodeBin, [sidecarScript, '--serve'], {
            cwd: tempDir,
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, NODE_PATH: nodeModulesPath }
        });

        const reqPayload = {
            id: 'ctx-test-1',
            code: `
                if (process.env.VURA_DATAVERSE_TOKEN) throw new Error('env polluted with token');
                if (!ctx || ctx.token !== 'secret_token_123') throw new Error('ctx.token mismatch');
                if (state.context.token !== 'secret_token_123') throw new Error('state.context.token mismatch');
                console.log('CTX_NODE_OK');
            `,
            ctx: { token: 'secret_token_123', depthLimit: 10 }
        };

        expect(validateRequest(reqPayload)).toBe(true);

        const reqStr = JSON.stringify(reqPayload) + '\n';
        const resultPromise = new Promise<any>((resolve) => {
            worker.stdout.on('data', (d) => {
                const line = d.toString().trim();
                if (line) resolve(JSON.parse(line));
            });
        });

        worker.stdin.write(reqStr);
        const res = await resultPromise;
        worker.kill();

        expect(validateResponse(res)).toBe(true);
        expect(res.status).toBe('ok');
        expect(res.stdout).toContain('CTX_NODE_OK');
    });

    it('2b. Context and token injection without env pollution in Python sidecar', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.py');
        const pythonBin = 'python3';

        const worker = spawn(pythonBin, ['-u', sidecarScript], {
            cwd: tempDir,
            env: { ...process.env, VURA_STORAGE_PATH: tempDir }
        });

        const reqPayload = {
            id: 'py-ctx-1',
            code: [
                "import os",
                "if 'VURA_DATAVERSE_TOKEN' in os.environ: raise Exception('os.environ polluted with token')",
                "if ctx.get('token') != 'py_token_456': raise Exception('ctx token mismatch')",
                "if state.context.get('token') != 'py_token_456': raise Exception('state.context token mismatch')",
                "print('CTX_PYTHON_OK')"
            ].join('\n'),
            ctx: { token: 'py_token_456', depthLimit: 3 }
        };

        expect(validateRequest(reqPayload)).toBe(true);

        const reqStr = JSON.stringify(reqPayload) + '\n';
        const resultPromise = new Promise<any>((resolve) => {
            worker.stdout.on('data', (d) => {
                const line = d.toString().trim();
                if (line) resolve(JSON.parse(line));
            });
        });

        worker.stdin.write(reqStr);
        const res = await resultPromise;
        worker.kill();

        expect(validateResponse(res)).toBe(true);
        expect(res.status).toBe('ok');
        expect(res.stdout).toContain('CTX_PYTHON_OK');
    });

    it('2c & 2e. Timeout kills worker and acquire() spawns fresh process with new PID', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.js');
        const nodeBin = process.execPath || 'node';
        const poolKey = `timeout-test-nb:${Date.now()}`;

        const worker1 = await sidecarPool.acquire(poolKey, () => spawn(nodeBin, [sidecarScript, '--serve'], {
            cwd: tempDir,
            env: { ...process.env, VURA_STORAGE_PATH: tempDir }
        }));
        const initialPid = worker1.proc.pid;

        // Monkey-patch REQUEST_TIMEOUT_MS logic by testing custom timeout or short loop if possible
        // Here we test send with infinite loop code
        const hangPromise = sidecarPool.send(worker1, {
            code: 'while(true){}'
        });

        // Force timeout handling or verify rejection on process kill
        await expect(hangPromise).rejects.toThrow();

        // Check acquire gets a new worker with different PID
        const worker2 = await sidecarPool.acquire(poolKey, () => spawn(nodeBin, [sidecarScript, '--serve'], {
            cwd: tempDir,
            env: { ...process.env, VURA_STORAGE_PATH: tempDir }
        }));
        expect(worker2.proc.pid).not.toBe(initialPid);
        sidecarPool.release(poolKey, worker2);
    });

    it('2d. Single-flight guard rejects concurrent requests sent directly to sidecar', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.js');
        const nodeBin = process.execPath || 'node';
        const nodeModulesPath = path.dirname(path.dirname(require.resolve('parquetjs-lite/package.json')));

        const worker = spawn(nodeBin, [sidecarScript, '--serve'], {
            cwd: tempDir,
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, NODE_PATH: nodeModulesPath }
        });

        const responses: any[] = [];
        let resolveResponses: () => void;
        const gotTwoResponses = new Promise<void>(r => { resolveResponses = r; });

        worker.stdout.on('data', (d) => {
            const lines = d.toString().split('\n');
            for (const l of lines) {
                if (l.trim()) {
                    try {
                        responses.push(JSON.parse(l.trim()));
                        if (responses.length >= 2) resolveResponses();
                    } catch {}
                }
            }
        });

        const req1 = JSON.stringify({
            id: 'flight-1',
            code: 'const start = Date.now(); while(Date.now() - start < 300) {} console.log("DONE1");'
        });

        const req2 = JSON.stringify({
            id: 'flight-2',
            code: 'console.log("DONE2");'
        });

        worker.stdin.write(req1 + '\n' + req2 + '\n');

        await Promise.race([
            gotTwoResponses,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout waiting for 2 responses. Received: ${JSON.stringify(responses)}`)), 2000))
        ]);
        worker.kill();

        expect(responses.length).toBe(2);
        const resp2 = responses.find(r => r.id === 'flight-2');
        expect(resp2).toBeDefined();
        expect(resp2.status).toBe('error');
        expect(resp2.error).toContain('busy with another request');
    });
});
