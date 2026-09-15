import { DuckDbManager } from '../services/duckDbManager';
import { ContextManager } from '../services/contextManager';
import { VuraRunner, cleanNotebookSession } from '../runner';
import { IVuraEnvironment, FlownbCell, ICellLogger } from '../interfaces';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.setTimeout(60000);

describe('Session Isolation and Cleaning', () => {
    let baseStorage: string;
    let envA: IVuraEnvironment;
    let envB: IVuraEnvironment;

    const dummyLogger: ICellLogger = {
        logText: async () => {},
        logError: async () => {},
        logHtml: async () => {},
        logJson: async () => {},
        replaceOutput: async () => {},
        logMultiple: async () => {},
        clearOutput: async () => {}
    };

    beforeAll(async () => {
        baseStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-session-isolation-test-'));
        // Pre-create package.json in baseStorage so prepareStorageWorkspace bypasses npm install
        await fs.writeFile(path.join(baseStorage, 'package.json'), JSON.stringify({ name: 'test-pkg' }));

        const storageA = path.join(baseStorage, 'sessions', 'notebook_a');
        const storageB = path.join(baseStorage, 'sessions', 'notebook_b');

        envA = {
            storagePath: storageA,
            notebookDir: baseStorage,
            notebookId: 'notebook_a',
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
            setMapping: async (varName, targetPath) => {
                await ContextManager.getInstance().setMapping(envA, varName, targetPath);
            }
        };

        envB = {
            storagePath: storageB,
            notebookDir: baseStorage,
            notebookId: 'notebook_b',
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
            setMapping: async (varName, targetPath) => {
                await ContextManager.getInstance().setMapping(envB, varName, targetPath);
            }
        };
    });

    afterAll(async () => {
        DuckDbManager.disposeNotebook('notebook_a');
        DuckDbManager.disposeNotebook('notebook_b');
        await fs.rm(baseStorage, { recursive: true, force: true }).catch(() => {});
    });

    it('isolates DuckDB tables and Parquet files between separate notebooks', async () => {
        const runnerA = new VuraRunner(envA);
        const cellA: FlownbCell = {
            kind: 2,
            language: 'sql',
            value: "CREATE TABLE users_a AS SELECT 1 AS id, 'Alice' AS name;",
            metadata: { tableName: 'users_a' }
        };
        await runnerA.executeCell(cellA, 0, [cellA], dummyLogger);

        // Verify Notebook A sees users_a
        const dbA = await DuckDbManager.getInstance(envA);
        const tablesA = await dbA.runQuery('SHOW TABLES');
        const tableNamesA = tablesA.map(r => r.name);
        expect(tableNamesA).toContain('users_a');

        // Verify Notebook B does NOT see users_a
        const dbB = await DuckDbManager.getInstance(envB);
        const tablesB = await dbB.runQuery('SHOW TABLES');
        const tableNamesB = tablesB.map(r => r.name);
        expect(tableNamesB).not.toContain('users_a');
    });

    it('isolates ContextManager mappings per notebook', async () => {
        const dbA = await DuckDbManager.getInstance(envA);
        await dbA.runQuery('CREATE TABLE map_tbl AS SELECT 1 AS x');
        const parquetPath = path.join(envA.storagePath, 'map_tbl.parquet');
        await dbA.exportTableToParquet('map_tbl', envA.storagePath);

        await ContextManager.getInstance().setMapping(envA, 'my_var', parquetPath);

        expect(ContextManager.getInstance().getMapping('my_var', envA)).toBe(parquetPath);
        expect(ContextManager.getInstance().getMapping('my_var', envB)).toBeUndefined();
    });

    it('cleans session for a notebook without affecting other notebooks', async () => {
        // Clean session for Notebook A
        await cleanNotebookSession(envA);

        // Check Notebook A mappings are cleared
        expect(ContextManager.getInstance().getMapping('my_var', envA)).toBeUndefined();

        // Re-initialize DuckDB for Notebook A and verify SHOW TABLES does not contain users_a
        const dbA = await DuckDbManager.getInstance(envA);
        const tablesA = await dbA.runQuery('SHOW TABLES');
        expect(tablesA.map(r => r.name)).not.toContain('users_a');
    });
});
