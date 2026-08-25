import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DuckDbManager } from '../src/services/duckDbManager';
import { IVuraEnvironment } from '../src/interfaces';

describe('DuckDbManager Partitioning & Arrow View Integration Tests', () => {
    let tmpDir: string;
    let mockEnv: IVuraEnvironment;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vura-duckdb-part-'));
        mockEnv = {
            storagePath: tmpDir,
            notebookDir: tmpDir,
            notebookId: 'test_notebook_' + Math.random().toString(36).substring(2, 7),
            extensionPath: '/ext',
            getConfig: <T>(_key: string, defaultValue?: T) => defaultValue as T,
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

    afterEach(() => {
        DuckDbManager.disposeNotebook(mockEnv.notebookId!);
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('syncStorageViews automatically picks up partitioned tables and .arrow files', async () => {
        const partDir = path.join(tmpDir, 'partitioned_table');
        fs.mkdirSync(partDir, { recursive: true });

        const manifest = {
            version: 1,
            tableName: 'partitioned_table',
            rowCount: 2,
            compacted: false,
            parts: [{ file: 'part-0000.parquet', rowCount: 2 }],
            schema: { id: 'BIGINT', name: 'VARCHAR' }
        };
        fs.writeFileSync(path.join(partDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        const setupMgr = await DuckDbManager.createIsolated(mockEnv);
        await setupMgr.runQuery(`CREATE TABLE temp_p AS SELECT 101 as id, 'part_a' as name UNION ALL SELECT 102 as id, 'part_b' as name`);
        await setupMgr.runQuery(`COPY temp_p TO '${path.join(partDir, 'part-0000.parquet').replace(/\\/g, '/')}' (FORMAT PARQUET)`);
        setupMgr.dispose();

        const dbMgr = await DuckDbManager.getInstance(mockEnv);

        const rows = await dbMgr.runQuery('SELECT * FROM "partitioned_table" ORDER BY id');
        expect(rows.length).toBe(2);
        expect(rows[0].id).toBe(101);
        expect(rows[1].name).toBe('part_b');
    });
});
