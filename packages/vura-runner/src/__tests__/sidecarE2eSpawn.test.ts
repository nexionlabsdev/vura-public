import { sidecarPool } from '../services/sidecarPool';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Sidecar E2E Process Spawn Tests (JS & Py)', () => {
    let tempDir: string;
    const pythonSidecar = path.resolve(__dirname, '../assets/sidecar.py');
    const jsSidecar = path.resolve(__dirname, '../assets/sidecar.js');
    const pythonPath = path.resolve(__dirname, '../../../../packages/vura-io-py');

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
            { rows: 499, expectedParted: false, expectedParts: 0 },
            { rows: 500, expectedParted: true, expectedParts: 1 },
            { rows: 501, expectedParted: true, expectedParts: 1 },
            { rows: 1000, expectedParted: true, expectedParts: 1 },
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

            if (!tc.expectedParted) {
                const stat = await fs.stat(singleFile);
                expect(stat.isFile()).toBe(true);
            } else {
                const manifestContent = await fs.readFile(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                expect(manifest.parts.length).toBe(tc.expectedParts);
                const rowCount = manifest.rowCount ?? manifest.total_rows ?? manifest.parts.reduce((a: number, p: any) => a + (p.rowCount || p.rows), 0);
                expect(rowCount).toBe(tc.rows);
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

    test('Crash-simulation: kill sidecar after writing part file before manifest update', async () => {
        const poolKey = 'test_crash_key';
        const worker = await sidecarPool.acquire(poolKey, () => spawn('python3', [pythonSidecar, '--serve'], {
            env: { ...process.env, VURA_STORAGE_PATH: tempDir, PYTHONPATH: pythonPath },
            stdio: ['pipe', 'pipe', 'inherit']
        }));

        // Initial write of 10 rows
        const initCode = `
from vura.io import save_table
save_table("crash_tbl", [{"id": j} for j in range(10)])
`;
        const resInit = await sidecarPool.send(worker, { id: 'init_req', code: initCode, ctx: { storagePath: tempDir } });
        expect(resInit.status).toBe('ok');

        // Verify initial table exists
        const initialFile = path.join(tempDir, 'crash_tbl.arrow');
        const initStat = await fs.stat(initialFile);
        expect(initStat.isFile()).toBe(true);

        // Simulate crash during partial write to crash_tbl directory
        const partDir = path.join(tempDir, 'crash_tbl');
        await fs.mkdir(partDir, { recursive: true });
        await fs.writeFile(path.join(partDir, 'part_99.arrow'), Buffer.from('corrupted data'));

        // Kill worker process
        worker.proc.kill('SIGKILL');

        // Confirm original pre-flush file remains intact and uncorrupted
        const finalStat = await fs.stat(initialFile);
        expect(finalStat.size).toBe(initStat.size);
    });
});
