import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { data, state, metrics, shredJson, unshredJson } from '@vura/io';
import { DuckDbManager } from '../services/duckDbManager';

describe('VURA I/O & Relational DuckDB JSON Shredder', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vura-io-test-'));
        data.setStoragePath(tmpDir);
    });

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    const sampleNestedData = {
        order_id: 1001,
        customer: {
            name: 'Alice Johnson',
            email: 'alice@example.com',
            details: {
                tier: 'gold',
                active: true
            }
        },
        items: [
            {
                item_id: 'prod_1',
                title: 'Wireless Mouse',
                price: 29.99,
                qty: 2,
                tags: ['electronics', 'accessory'],
                options: { color: 'black' }
            },
            {
                item_id: 'prod_2',
                title: 'Mechanical Keyboard',
                price: 89.50,
                qty: 1,
                tags: ['electronics'],
                options: null
            }
        ],
        empty_array: [],
        null_value: null,
        numeric_list: [1, 2, 3, 4]
    };

    test('deeply nested JSON is shredded into multiple relational tables', async () => {
        const tableNames = await data.pack('orders', sampleNestedData);

        expect(tableNames).toContain('orders');
        expect(tableNames).toContain('orders_customer');
        expect(tableNames).toContain('orders_customer_details');
        expect(tableNames).toContain('orders_items');
        expect(tableNames).toContain('orders_items_tags');
        expect(tableNames).toContain('orders_items_options');
        expect(tableNames).toContain('orders_empty_array');
        expect(tableNames).toContain('orders_numeric_list');

        const datasetTables = await data.tables('orders');
        expect(datasetTables).toEqual(tableNames);
    });

    test('100% exact round-trip reconstruction (original === unpack(pack(original)))', async () => {
        await data.pack('orders', sampleNestedData);
        const reconstructed = await data.unpack('orders');

        expect(reconstructed).toEqual(sampleNestedData);
    });

    test('SQL query execution across shredded DuckDB tables', async () => {
        await data.pack('orders', sampleNestedData);

        const duckDb = await DuckDbManager.createIsolated();

        const tables = await data.tables('orders');
        for (const tbl of tables) {
            const parquetPath = path.join(tmpDir, `${tbl}.parquet`).replace(/\\/g, '/');
            await duckDb.runQuery(`CREATE VIEW "${tbl}" AS SELECT * FROM read_parquet('${parquetPath}')`);
        }

        const queryResult = await duckDb.runQuery(`
            SELECT i.item_id, i.price, i.qty, c.name as customer_name
            FROM orders_items i
            JOIN orders_customer c ON 1=1
            WHERE i.price > 30
        `);

        expect(queryResult).toHaveLength(1);
        expect(queryResult[0].item_id).toBe('prod_2');
        expect(queryResult[0].customer_name).toBe('Alice Johnson');

        duckDb.dispose();
    });

    test('state namespace set, get, context', () => {
        state.set('my_var', { key: 'value' });
        expect(state.get('my_var')).toEqual({ key: 'value' });
        expect(state.get('non_existent', 'default')).toBe('default');

        const ctx = state.context;
        expect(ctx).toHaveProperty('storagePath');
        expect(ctx).toHaveProperty('notebookId');
    });

    test('metrics namespace track, log, preview', () => {
        const spyErr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});

        metrics.track('loss', 0.05, 10);
        expect(spyErr).toHaveBeenCalled();

        metrics.log('Starting execution', 'INFO');
        expect(spyLog).toHaveBeenCalledWith('[INFO] Starting execution');

        metrics.preview('orders', { row_count: 2 });
        expect(spyErr).toHaveBeenCalled();

        spyErr.mockRestore();
        spyLog.mockRestore();
    });
});
