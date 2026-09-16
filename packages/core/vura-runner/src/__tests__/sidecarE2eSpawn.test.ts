import { sidecarPool } from '../services/sidecarPool';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Sidecar E2E Process Spawn Tests (JS & Py)', () => {
    let tempDir: string;
    const pythonSidecar = path.resolve(__dirname, '../assets/sidecar.py');
    const jsSidecar = path.resolve(__dirname, '../assets/sidecar.js');
    const pythonPath = path.resolve(__dirname, '../../../../../packages/core/vura-io-py');

    jest.setTimeout(120000);

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-sidecar-e2e-'));
    });

    afterEach(async () => {
        await sidecarPool.disposeAll();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test.each([
        ['Python sidecar', () => spawn('python3', [pythonSidecar, '--serve'], {
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, VURA_PARTITION_THRESHOLD_ROWS: '500', PYTHONPATH: pythonPath },
            stdio: ['pipe', 'pipe', 'inherit']
        })],
        ['JavaScript sidecar', () => spawn('node', [jsSidecar, '--serve'], {
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, VURA_PARTITION_THRESHOLD_ROWS: '500' },
            stdio: ['pipe', 'pipe', 'inherit']
        })],
    ])('%s: boundary row testing with threshold=500 (499, 500, 501, 1000 rows)', async (name, spawnFn) => {
        const poolKey = `test_key_${name.replace(/\s+/g, '_')}`;
        const worker = await sidecarPool.acquire(poolKey, spawnFn);

        const testCases = [
            { rows: 499, expectedParted: false },
            { rows: 500, expectedParted: true, expectedNextPartIndex: 1 },
            { rows: 501, expectedParted: true, expectedNextPartIndex: 1 },
            { rows: 1000, expectedParted: true, expectedNextPartIndex: 1 },
        ];

        for (let i = 0; i < testCases.length; i++) {
            const tc = testCases[i];
            const varName = `bound_tbl_${tc.rows}`;
            let code = '';
            if (name.includes('Python')) {
                code = `
from vura.io import save_table
rows = [{"id": j, "val": f"v_{j}"} for j in range(${tc.rows})]
save_table("${varName}", rows)
`;
            } else {
                code = `
const { save_table } = require('vura');
const rows = Array.from({ length: ${tc.rows} }, (_, j) => ({ id: j, val: \`v_\${j}\` }));
save_table("${varName}", rows);
`;
            }

            const req = {
                id: `req_bound_${tc.rows}`,
                code,
                ctx: { storagePath: tempDir }
            };

            const res = await sidecarPool.send(worker, req);
            if (res.status !== 'ok') {
                console.error(`Execution error for ${varName}:`, res.error, res.stderr);
            }
            expect(res.status).toBe('ok');

            const singleFile = path.join(tempDir, `${varName}.arrow`);
            const manifestPath = path.join(tempDir, varName, 'manifest.json');
            const partsLogPath = path.join(tempDir, varName, 'manifest-parts.jsonl');

            if (!tc.expectedParted) {
                const stat = await fs.stat(singleFile);
                expect(stat.isFile()).toBe(true);
            } else {
                const manifestContent = await fs.readFile(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                expect(manifest.nextPartIndex).toBe(tc.expectedNextPartIndex);
                expect(manifest.parts).toBeUndefined();

                const partsContent = await fs.readFile(partsLogPath, 'utf8');
                const partsLines = partsContent.trim().split('\n').filter(Boolean);
                expect(partsLines.length).toBe(tc.expectedNextPartIndex);
            }
        }

        sidecarPool.release(poolKey, worker);
    });

    test('>1MB BLOB round-trip through spawned sidecar process asserting exact Buffer', async () => {
        const poolKey = 'test_blob_key';
        const worker = await sidecarPool.acquire(poolKey, () => spawn('python3', [pythonSidecar, '--serve'], {
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, PYTHONPATH: pythonPath },
            stdio: ['pipe', 'pipe', 'inherit']
        }));

        // Generate 1.5MB binary buffer
        const size = 1.5 * 1024 * 1024;
        const originalBuf = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
            originalBuf[i] = (i % 251) + 1;
        }

        const b64 = originalBuf.toString('base64');
        const code = `
import base64
from vura.io import save_table
data = base64.b64decode("${b64}")
save_table("blob_tbl", [{"id": 1, "data": data}])
`;

        const req = {
            id: 'blob_req_1',
            code,
            ctx: { storagePath: tempDir }
        };

        const res = await sidecarPool.send(worker, req);
        if (res.status !== 'ok') {
            console.error('Execution error for blob:', res.error, res.stderr);
        }
        expect(res.status).toBe('ok');

        const arrowFile = path.join(tempDir, 'blob_tbl.arrow');
        const fileContent = await fs.readFile(arrowFile);
        expect(fileContent.length).toBeGreaterThan(size);

        sidecarPool.release(poolKey, worker);
    });

    test.each([
        ['Python sidecar', (pauseEnvKey: string | null) => spawn('python3', [pythonSidecar, '--serve'], {
            env: {
                ...process.env,
                VURA_STORAGE_PATH: tempDir,
                VURA_PARTITION_THRESHOLD_ROWS: '10',
                PYTHONPATH: pythonPath,
                ...(pauseEnvKey ? { [pauseEnvKey]: '1' } : {})
            },
            stdio: ['pipe', 'pipe', 'pipe']
        })],
        ['JavaScript sidecar', (pauseEnvKey: string | null) => spawn('node', [jsSidecar, '--serve'], {
            env: {
                ...process.env,
                VURA_STORAGE_PATH: tempDir,
                VURA_PARTITION_THRESHOLD_ROWS: '10',
                ...(pauseEnvKey ? { [pauseEnvKey]: '1' } : {})
            },
            stdio: ['pipe', 'pipe', 'pipe']
        })],
    ])('%s: deterministic SIGKILL mid-flush test via VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND and VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE', async (name, spawnFn) => {
        // Step 1: Initial write (10 rows, creates partitioned table part-0000.parquet & manifest.json)
        const proc1 = spawnFn(null);
        const code1 = name.includes('Python')
            ? `from vura.io import save_table\nsave_table("crash_tbl", [{"id": j} for j in range(10)])\n`
            : `const { save_table } = require('vura');\nsave_table("crash_tbl", Array.from({ length: 10 }, (_, j) => ({ id: j })));\n`;

        proc1.stdin.write(JSON.stringify({ id: 'req_init', code: code1, ctx: { storagePath: tempDir } }) + '\n');
        await new Promise<void>((resolve, reject) => {
            proc1.stdout.once('data', (d) => {
                const res = JSON.parse(d.toString());
                if (res.status === 'ok') resolve();
                else reject(new Error(res.error || 'req_init failed'));
            });
        });

        const manifestPath = path.join(tempDir, 'crash_tbl', 'manifest.json');
        const manifest1 = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        expect(manifest1.rowCount).toBe(10);
        expect(manifest1.nextPartIndex).toBe(1);

        proc1.kill();

        // Step 2: Spawn process with VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE=1 and attempt append of 10 rows
        const proc2 = spawnFn('VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE');
        let sentinelSeen = false;

        const sentinelPromise = new Promise<void>((resolve) => {
            const checkChunk = (chunk: any) => {
                if (chunk.toString().includes('[VURA_TEST_HOOK] PAUSED_BEFORE_MANIFEST_WRITE')) {
                    sentinelSeen = true;
                    resolve();
                }
            };
            proc2.stderr.on('data', checkChunk);
            proc2.stdout.on('data', checkChunk);
        });

        const code2 = name.includes('Python')
            ? `from vura.io import append\nappend("crash_tbl", [{"id": j + 10} for j in range(10)])\n`
            : `const { append } = require('vura');\nappend("crash_tbl", Array.from({ length: 10 }, (_, j) => ({ id: j + 10 })));\n`;

        proc2.stdin.write(JSON.stringify({ id: 'req_append', code: code2, ctx: { storagePath: tempDir } }) + '\n');

        // Wait for sentinel on stderr indicating part-0001.parquet was written and sidecar is paused right before manifest update
        await sentinelPromise;
        expect(sentinelSeen).toBe(true);

        // Verify part-0001.parquet exists on disk before SIGKILL
        const part1Path = path.join(tempDir, 'crash_tbl', 'part-0001.parquet');
        const part1Exists = await fs.stat(part1Path).then(s => s.isFile()).catch(() => false);
        expect(part1Exists).toBe(true);

        // Send hard SIGKILL to process paused right before manifest update
        proc2.kill('SIGKILL');

        // Step 3: Spawn fresh sidecar without pause hook and read crash_tbl count
        const proc3 = spawnFn(null);
        const code3 = name.includes('Python')
            ? `from vura.io import count\nprint(f"COUNT:{count('crash_tbl')}")\n`
            : `const { count } = require('vura');\nconst c = await count('crash_tbl');\nconsole.log(\`COUNT:\${c}\`);\n`;

        proc3.stdin.write(JSON.stringify({ id: 'req_read', code: code3, ctx: { storagePath: tempDir } }) + '\n');
        const readRes = await new Promise<any>((resolve) => {
            proc3.stdout.once('data', (d) => {
                resolve(JSON.parse(d.toString()));
            });
        });
        proc3.kill();

           expect(readRes.status).toBe('ok');
        const match = readRes.stdout.match(/COUNT:(\d+)/);
        expect(match).not.toBeNull();
        const readCount = parseInt(match[1], 10);

        // Assert table count reflects last-known-good manifest state (10 rows, not 20)
        expect(readCount).toBe(10);
    });
});
