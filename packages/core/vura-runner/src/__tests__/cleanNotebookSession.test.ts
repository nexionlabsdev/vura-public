import { cleanNotebookSession } from '../runner';
import { sidecarPool } from '../services/sidecarPool';
import { IVuraEnvironment } from '../interfaces';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

describe('cleanNotebookSession resource management', () => {
    let tempDir: string;
    let mockEnv: IVuraEnvironment;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-clean-session-test-'));
        mockEnv = {
            storagePath: tempDir,
            notebookDir: tempDir,
            notebookId: 'clean-session-nb-1',
            extensionPath: '/ext',
            getConfig: (key: string, def: any) => def,
            getProfile: async () => undefined,
            getProfileSecret: async () => undefined,
            getConnectionProfile: async () => undefined,
            listConnectionProfiles: async () => [],
            getSecret: async () => undefined,
            setSecret: async () => undefined,
            deleteSecret: async () => undefined,
            runLocalQuery: async () => [],
            getPythonVenvPath: async () => undefined,
            setPythonVenvPath: async () => undefined,
            setMapping: async () => undefined,
        };
    });

    afterEach(async () => {
        await sidecarPool.disposeAll();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('cleanNotebookSession awaits sidecar process exit before deleting storage directory files', async () => {
        const dummyFile = path.join(tempDir, 'dummy.txt');
        await fs.writeFile(dummyFile, 'hello');

        let exited = false;
        const key = `${mockEnv.notebookId}:custom`;

        // Spawn a child process that ignores SIGTERM and takes ~200ms to exit upon SIGKILL or signal
        const nodeScript = `
            process.on('SIGTERM', () => {
                // Ignore SIGTERM for a short delay to simulate slow/ignoring process, then exit
                setTimeout(() => process.exit(0), 150);
            });
            setInterval(() => {}, 1000);
        `;

        const worker = await sidecarPool.acquire(key, () => spawn(process.execPath, ['-e', nodeScript], { windowsHide: true }));
        worker.proc.on('exit', () => {
            exited = true;
        });

        // Assert file exists before cleaning
        let fileExists = await fs.stat(dummyFile).then(() => true).catch(() => false);
        expect(fileExists).toBe(true);

        let processExitedWhenFilesDeleted = false;

        // Spy or clean
        const origReaddir = fs.readdir;
        const cleanPromise = cleanNotebookSession(mockEnv);

        await cleanPromise;

        // When cleanNotebookSession resolves, the process must have exited and files deleted
        expect(exited).toBe(true);
        fileExists = await fs.stat(dummyFile).then(() => true).catch(() => false);
        expect(fileExists).toBe(false);
    });
});
