import { DuckDbManager } from '../services/duckDbManager';
import { IVuraEnvironment } from '../interfaces';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.setTimeout(30000);

describe('DuckDbManager (@duckdb/node-api)', () => {
    let tempDir: string;
    let mockEnv: IVuraEnvironment;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-duckdb-test-'));
        mockEnv = {
            storagePath: tempDir,
            notebookDir: tempDir,
            notebookId: 'test-db-1',
            extensionPath: '/ext',
            getConfig: (key: string, def: any) => def,
            getProfile: async () => undefined,
            getProfileSecret: async () => undefined,
            getSecret: async () => undefined,
            setSecret: async () => undefined,
            deleteSecret: async () => undefined,
            runLocalQuery: async () => [],
            getPythonVenvPath: async () => undefined,
            setPythonVenvPath: async () => undefined,
            setMapping: async () => undefined,
        };
    });

    afterAll(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('initializes and executes queries with parameter binding', async () => {
        const mgr = await DuckDbManager.getInstance(mockEnv);
        await mgr.runQuery('CREATE TABLE test_users (id INT, name VARCHAR, val DOUBLE)');
        await mgr.runQuery('INSERT INTO test_users VALUES (?, ?, ?)', [1, 'Alice', 99.5]);

        const rows = await mgr.runQuery('SELECT * FROM test_users WHERE id = ?', [1]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ id: 1, name: 'Alice', val: 99.5 });
    });

    it('creates an isolated in-memory instance', async () => {
        const iso = await DuckDbManager.createIsolated();
        await iso.runQuery('CREATE TABLE iso_test (col VARCHAR)');
        await iso.runQuery("INSERT INTO iso_test VALUES ('isolated_val')");

        const res = await iso.runQuery('SELECT * FROM iso_test');
        expect(res).toEqual([{ col: 'isolated_val' }]);
        iso.dispose();
    });

    it('exports a table to Parquet and manages Views', async () => {
        const mgr = await DuckDbManager.getInstance(mockEnv);
        await mgr.runQuery('CREATE TABLE sales (id INT, amount INT)');
        await mgr.runQuery('INSERT INTO sales VALUES (1, 100), (2, 200)');

        const parquetPath = path.join(tempDir, 'sales.parquet');
        await mgr.exportTableToParquet('sales', tempDir);

        const exists = await fs.stat(parquetPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        await mgr.updateView('v_sales', parquetPath);
        const vRows = await mgr.runQuery('SELECT * FROM v_sales');
        expect(vRows).toHaveLength(2);

        await mgr.dropView('v_sales');
        await expect(mgr.runQuery('SELECT * FROM v_sales')).rejects.toThrow();
    });

    it('handles queryArrowIPC and saveTableArrowIPC round-trip', async () => {
        const mgr = await DuckDbManager.getInstance(mockEnv);
        await mgr.runQuery('CREATE TABLE ipc_src (id INT, item VARCHAR)');
        await mgr.runQuery("INSERT INTO ipc_src VALUES (10, 'widget'), (20, 'gadget')");

        const ipcBuffer = await mgr.getTableArrowIPC('ipc_src');
        expect(ipcBuffer.length).toBeGreaterThan(0);

        await mgr.saveTableArrowIPC('ipc_dest', ipcBuffer);
        const destRows = await mgr.runQuery('SELECT * FROM ipc_dest');
        expect(destRows).toEqual([
            { id: 10, item: 'widget' },
            { id: 20, item: 'gadget' }
        ]);
    });
});
