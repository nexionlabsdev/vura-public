import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

describe('Sidecar Module Resolution (@vura/io, vura, vura_io, vura_bridge)', () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-sidecar-mod-test-'));
        const assetsDir = path.join(__dirname, '..', 'assets');
        await fs.copyFile(path.join(assetsDir, 'sidecar.js'), path.join(tempDir, 'sidecar.js'));
        await fs.copyFile(path.join(assetsDir, 'sidecar.py'), path.join(tempDir, 'sidecar.py'));
    });

    afterAll(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('resolves @vura/io, vura-io, vura_io, vura_bridge, and vura in Node.js sidecar', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.js');
        const nodeBin = process.execPath || 'node';
        const nodeModulesPath = path.dirname(path.dirname(require.resolve('parquetjs-lite/package.json')));

        const worker = spawn(nodeBin, [sidecarScript, '--serve'], {
            cwd: tempDir,
            env: {
                ...process.env,
                VURA_STORAGE_PATH: tempDir,
                NODE_PATH: nodeModulesPath
            }
        });

        const testScript = `
            const io1 = require('@vura/io');
            const io2 = require('vura-io');
            const io3 = require('vura_io');
            const bridge = require('vura_bridge');
            const vuraMod = require('vura');

            if (!io1 || !io1.data) throw new Error('@vura/io missing data');
            if (!io2 || !io2.data) throw new Error('vura-io missing data');
            if (!io3 || !io3.data) throw new Error('vura_io missing data');
            if (!bridge || !bridge.data) throw new Error('vura_bridge missing data');
            if (!vuraMod || !vuraMod.io) throw new Error('vura missing io');

            console.log('ALL_NODE_MODULES_RESOLVED_OK');
        `;

        const req = JSON.stringify({
            id: 'test-1',
            code: testScript,
            filename: path.join(tempDir, 'test.js'),
            env: {}
        }) + '\n';

        const resultPromise = new Promise<any>((resolve, reject) => {
            let buf = '';
            worker.stdout.on('data', (d) => {
                buf += d.toString();
                const lines = buf.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const parsed = JSON.parse(line.trim());
                            if (parsed.id === 'test-1') {
                                resolve(parsed);
                                return;
                            }
                        } catch (e) {}
                    }
                }
            });
            worker.on('error', reject);
        });

        worker.stdin.write(req);
        const res = await resultPromise;
        worker.kill();

        if (res.status !== 'ok') {
            console.error('Node Sidecar Error:', res.error);
        }
        expect(res.status).toBe('ok');
        expect(res.stdout).toContain('ALL_NODE_MODULES_RESOLVED_OK');
    });

    it('resolves vura, vura.io, vura_io, and vura_bridge in Python sidecar', async () => {
        const sidecarScript = path.join(tempDir, 'sidecar.py');
        const pythonBin = 'python3';

        const worker = spawn(pythonBin, ['-u', sidecarScript], {
            cwd: tempDir,
            env: {
                ...process.env,
                VURA_STORAGE_PATH: tempDir
            }
        });

        const pyScript = [
            "import vura",
            "import vura.io",
            "import vura_io",
            "import vura_bridge",
            "from vura import io",
            "from vura.io import data, get_table",
            "from vura_bridge import get_table, save_table",
            "print('ALL_PYTHON_MODULES_RESOLVED_OK')"
        ].join("\n");

        const req = JSON.stringify({
            id: 'py-test-1',
            code: pyScript,
            env: {}
        }) + '\n';

        const resultPromise = new Promise<any>((resolve, reject) => {
            let buf = '';
            worker.stdout.on('data', (d) => {
                buf += d.toString();
                const lines = buf.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const parsed = JSON.parse(line.trim());
                            if (parsed.id === 'py-test-1') {
                                resolve(parsed);
                                return;
                            }
                        } catch (e) {}
                    }
                }
            });
            worker.on('error', reject);
        });

        worker.stdin.write(req);
        const res = await resultPromise;
        worker.kill();

        if (res.status !== 'ok') {
            console.error('Python Sidecar Error:', res.error);
        }
        expect(res.status).toBe('ok');
        expect(res.stdout).toContain('ALL_PYTHON_MODULES_RESOLVED_OK');
    });
});
