import { VuraRunner } from '../runner';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.setTimeout(30000);

describe('Shredded Tables Mapping & DuckDB Views Visibility', () => {
    let tempDir: string;
    let env: IVuraEnvironment;
    let loggerOutput: { text: string[] };
    let mockLogger: ICellLogger;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-shredded-tables-test-'));

        // Symlink node_modules so sidecar finds parquetjs-lite without network npm install
        const runnerNodeModules = path.dirname(path.dirname(require.resolve('parquetjs-lite/package.json')));
        await fs.symlink(runnerNodeModules, path.join(tempDir, 'node_modules'), 'dir').catch(() => {});

        await fs.writeFile(
            path.join(tempDir, 'package.json'),
            JSON.stringify({ name: 'vura-test-shredded', private: true }),
            'utf8'
        );

        loggerOutput = { text: [] };

        env = {
            storagePath: tempDir,
            notebookDir: tempDir,
            notebookId: `shredded-${Date.now()}`,
            extensionPath: tempDir,
            getConfig: (key: string, defaultValue: any) => defaultValue,
            getProfile: async () => undefined,
            getProfileSecret: async () => undefined,
            getConnectionProfile: async () => undefined,
            listConnectionProfiles: async () => [],
            getSecret: async () => undefined,
            setSecret: async () => undefined,
            deleteSecret: async () => undefined,
            runLocalQuery: async (sql: string) => {
                const mgr = await DuckDbManager.getInstance(env);
                return mgr.runQuery(sql);
            },
            getPythonVenvPath: async () => undefined,
            setPythonVenvPath: async () => undefined,
            setMapping: async () => undefined,
        };

        mockLogger = {
            logText: async (text: string) => { loggerOutput.text.push(text); },
            logError: async (err: string) => { loggerOutput.text.push(`ERROR: ${err}`); },
            logHtml: async () => {},
            logJson: async () => {},
            replaceOutput: async () => {},
            logMultiple: async () => {},
            clearOutput: async () => {}
        };
    });

    afterEach(async () => {
        try {
            const dbMgr = await DuckDbManager.getInstance(env);
            dbMgr.dispose();
        } catch {}
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    });

    it('emits mappings and creates DuckDB views for all shredded child tables (products, metadata, dimensions, tags, details)', async () => {
        const runner = new VuraRunner(env);

        const complexJson = {
            products: [
                { id: 101, name: 'Pro Laptop' },
                { id: 102, name: 'Wireless Mouse' }
            ],
            metadata: { version: '1.0', owner: 'inventory-team' },
            dimensions: [
                { width: 10, height: 20, weight: 1.5 }
            ],
            tags: ['tech', 'hardware', 'office'],
            details: { category: 'electronics', inStock: true }
        };

        const cells: FlownbCell[] = [
            // Cell 0: Node cell that uses vura/io pack
            {
                kind: 2,
                language: 'javascript',
                value: `
                    const { pack } = require('@vura-data-os/vura-io');
                    const complexData = ${JSON.stringify(complexJson)};
                    await pack('products', complexData);
                    console.log('PACK_COMPLETED');
                `,
                metadata: { label: 'pack_cell' }
            },
            // Cell 1: SQL cell querying root table products
            {
                kind: 2,
                language: 'sql',
                value: `SELECT * FROM products;`,
                metadata: { label: 'sql_products' }
            },
            // Cell 2: SQL cell querying child table metadata
            {
                kind: 2,
                language: 'sql',
                value: `SELECT * FROM metadata;`,
                metadata: { label: 'sql_metadata' }
            },
            // Cell 3: SQL cell querying child table dimensions
            {
                kind: 2,
                language: 'sql',
                value: `SELECT * FROM dimensions;`,
                metadata: { label: 'sql_dimensions' }
            },
            // Cell 4: SQL cell querying child table tags
            {
                kind: 2,
                language: 'sql',
                value: `SELECT * FROM tags;`,
                metadata: { label: 'sql_tags' }
            },
            // Cell 5: SQL cell querying child table details
            {
                kind: 2,
                language: 'sql',
                value: `SELECT * FROM details;`,
                metadata: { label: 'sql_details' }
            }
        ];

        const result = await runner.executeNotebook(cells, mockLogger);
        if (result.status !== 'success') {
            console.error('Notebook Error:', (result.error as any)?.stack || result.error);
        }
        expect(result.status).toBe('success');

        const dbMgr = await DuckDbManager.getInstance(env);

        // Verify root table products
        const productsRows = await dbMgr.runQuery('SELECT * FROM products');
        expect(productsRows.length).toBeGreaterThan(0);

        // Verify child table metadata
        const metaRows = await dbMgr.runQuery('SELECT * FROM metadata');
        expect(metaRows.length).toBeGreaterThan(0);

        // Verify child table dimensions
        const dimRows = await dbMgr.runQuery('SELECT * FROM dimensions');
        expect(dimRows.length).toBeGreaterThan(0);

        // Verify child table tags
        const tagRows = await dbMgr.runQuery('SELECT * FROM tags');
        expect(tagRows.length).toBeGreaterThan(0);

        // Verify child table details
        const detailRows = await dbMgr.runQuery('SELECT * FROM details');
        expect(detailRows.length).toBeGreaterThan(0);
    });
});
