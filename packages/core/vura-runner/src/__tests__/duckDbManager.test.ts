import { DuckDbManager, formatTimestampForDuckDb } from '../services/duckDbManager';
import { IVuraEnvironment } from '../interfaces';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as arrow from 'apache-arrow';

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

    it('withIsolated disposes its instance even when fn resolves or throws', async () => {
        let capturedMgr: DuckDbManager | undefined;
        const result = await DuckDbManager.withIsolated(async (mgr) => {
            capturedMgr = mgr;
            await mgr.runQuery('CREATE TABLE with_iso_test (val INT)');
            await mgr.runQuery('INSERT INTO with_iso_test VALUES (42)');
            const rows = await mgr.runQuery('SELECT * FROM with_iso_test');
            return rows[0].val;
        });
        expect(result).toBe(42);
        expect(capturedMgr).toBeDefined();
        await expect(capturedMgr!.runQuery('SELECT 1')).rejects.toThrow();

        let errorMgr: DuckDbManager | undefined;
        await expect(DuckDbManager.withIsolated(async (mgr) => {
            errorMgr = mgr;
            throw new Error('Callback failure');
        })).rejects.toThrow('Callback failure');
        expect(errorMgr).toBeDefined();
        await expect(errorMgr!.runQuery('SELECT 1')).rejects.toThrow();
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

    it('syncStorageViews does not demote an already-loaded base table into a view over its own parquet export', async () => {
        const mgr = await DuckDbManager.getInstance(mockEnv);
        await mgr.runQuery('DROP TABLE IF EXISTS cell_account_seed');
        await mgr.runQuery('CREATE TABLE cell_account_seed (id INT, name VARCHAR)');
        await mgr.runQuery("INSERT INTO cell_account_seed VALUES (1, 'Contoso')");

        // Mirrors what executeSql() does after every cell run: export the base table it just
        // created/updated to a parquet snapshot in storagePath.
        await mgr.exportTableToParquet('cell_account_seed', tempDir);

        // This runs at the top of every subsequent SQL cell execution. Before the fix, it
        // unconditionally replaced every table (including cell_account_seed, since its parquet
        // snapshot is sitting right there) with a read-only VIEW over that snapshot.
        await mgr.syncStorageViews(mockEnv);

        const tableType = await mgr.runQuery(
            `SELECT table_type FROM information_schema.tables WHERE table_name = 'cell_account_seed'`
        );
        expect(tableType).toEqual([{ table_type: 'BASE TABLE' }]);

        // The actual reported symptom: DuckDB refuses UPDATE/DELETE/INSERT against a view.
        await expect(
            mgr.runQuery("UPDATE cell_account_seed SET name = 'Updated' WHERE id = 1")
        ).resolves.not.toThrow();

        const rows = await mgr.runQuery('SELECT * FROM cell_account_seed');
        expect(rows).toEqual([{ id: 1, name: 'Updated' }]);
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

    describe('Timestamp handling in DuckDbManager and formatTimestampForDuckDb', () => {
        it('properly formats timestamps from numbers, strings, Dates, and BigInts', () => {
            const expectedIso = new Date(1789499102000).toISOString();
            expect(formatTimestampForDuckDb(1789499102000)).toBe(expectedIso);
            expect(formatTimestampForDuckDb('1789499102000')).toBe(expectedIso);
            expect(formatTimestampForDuckDb(1789499102000000n)).toBe(expectedIso);
            expect(formatTimestampForDuckDb(1789499102)).toBe(expectedIso);
            expect(formatTimestampForDuckDb(new Date(1789499102000))).toBe(expectedIso);
            expect(formatTimestampForDuckDb(expectedIso)).toBe(expectedIso);
            expect(formatTimestampForDuckDb(null)).toBeNull();
            expect(formatTimestampForDuckDb(undefined)).toBeNull();
            expect(formatTimestampForDuckDb(NaN)).toBeNull();
        });

        it('saves arrow table with epoch timestamp columns without throwing out of range error', async () => {
            const mgr = await DuckDbManager.getInstance(mockEnv);
            const tsMs = arrow.vectorFromArray([1789499102000], new arrow.TimestampMillisecond());
            const ids = arrow.vectorFromArray([1], new arrow.Int32());
            const table = new arrow.Table({
                id: ids,
                ts: tsMs
            });

            const ipcBuffer = Buffer.from(arrow.tableToIPC(table, 'file'));
            await expect(mgr.saveTableArrowIPC('ipc_ts_test', ipcBuffer)).resolves.not.toThrow();

            const rows = await mgr.runQuery('SELECT * FROM ipc_ts_test');
            expect(rows.length).toBe(1);
            expect(rows[0].id).toBe(1);
            expect(rows[0].ts).toBe(new Date(1789499102000).toISOString());
        });
    });
});

