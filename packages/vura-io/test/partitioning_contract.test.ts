import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as arrow from 'apache-arrow';
import { DataManager } from '../src/data';

describe('Phase 6 Partitioning & Threshold Contract Tests (TS)', () => {
    let tmpDir: string;
    let dataMgr: DataManager;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vura-test-part-'));
        process.env.VURA_STORAGE_PATH = tmpDir;
        process.env.VURA_PARTITION_THRESHOLD_ROWS = '10';
        dataMgr = new DataManager(tmpDir);
    });

    afterEach(() => {
        delete process.env.VURA_PARTITION_THRESHOLD_ROWS;
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('boundary test: threshold-1 (9 rows) writes single .arrow file', async () => {
        const rows = Array.from({ length: 9 }, (_, i) => ({ id: i, name: `row_${i}` }));
        await dataMgr.put('test_tbl', rows);

        const arrowFile = path.join(tmpDir, 'test_tbl.arrow');
        const manifestFile = path.join(tmpDir, 'test_tbl', 'manifest.json');

        expect(fs.existsSync(arrowFile)).toBe(true);
        expect(fs.existsSync(manifestFile)).toBe(false);

        const count = await dataMgr.count('test_tbl');
        expect(count).toBe(9);

        const fetched = await dataMgr.get('test_tbl');
        expect(fetched.length).toBe(9);
    });

    test('boundary test: exact threshold (10 rows) writes partitioned table', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row_${i}` }));
        await dataMgr.put('test_tbl', rows);

        const arrowFile = path.join(tmpDir, 'test_tbl.arrow');
        const manifestFile = path.join(tmpDir, 'test_tbl', 'manifest.json');
        const part0 = path.join(tmpDir, 'test_tbl', 'part-0000.parquet');

        expect(fs.existsSync(manifestFile)).toBe(true);
        expect(fs.existsSync(part0)).toBe(true);
        expect(fs.existsSync(arrowFile)).toBe(false);

        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-utf-8' in Buffer ? 'utf-8' : 'utf8'));
        expect(manifest.version).toBe(1);
        expect(manifest.rowCount).toBe(10);
        expect(manifest.parts.length).toBe(1);

        const count = await dataMgr.count('test_tbl');
        expect(count).toBe(10);
    });

    test('migration test: appending to single .arrow table crossing threshold converts to partitioned', async () => {
        const initialRows = Array.from({ length: 6 }, (_, i) => ({ id: i, val: `init_${i}` }));
        await dataMgr.put('mig_tbl', initialRows);

        const arrowFile = path.join(tmpDir, 'mig_tbl.arrow');
        expect(fs.existsSync(arrowFile)).toBe(true);

        const appRows = Array.from({ length: 5 }, (_, i) => ({ id: i + 6, val: `app_${i}` }));
        await dataMgr.append('mig_tbl', appRows);
        await dataMgr.flush('mig_tbl');

        expect(fs.existsSync(arrowFile)).toBe(false);

        const manifestFile = path.join(tmpDir, 'mig_tbl', 'manifest.json');
        const part0 = path.join(tmpDir, 'mig_tbl', 'part-0000.parquet');
        const part1 = path.join(tmpDir, 'mig_tbl', 'part-0001.parquet');

        expect(fs.existsSync(manifestFile)).toBe(true);
        expect(fs.existsSync(part0)).toBe(true);
        expect(fs.existsSync(part1)).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        expect(manifest.rowCount).toBe(11);
        expect(manifest.parts.length).toBe(2);

        const readBack = await dataMgr.get('mig_tbl');
        expect(readBack.length).toBe(11);
    });

    test('stream({ format: "arrow" }) returns genuine Apache Arrow Table', async () => {
        const rows = Array.from({ length: 15 }, (_, i) => ({ id: i, score: i * 10 }));
        await dataMgr.put('stream_tbl', rows);

        const batches: any[] = [];
        for await (const chunk of dataMgr.stream('stream_tbl', { batchSize: 5, format: 'arrow' })) {
            batches.push(chunk);
        }

        expect(batches.length).toBeGreaterThan(0);
        expect(batches[0] instanceof arrow.Table).toBe(true);
    });

    test('atomic recovery simulation: un-updated manifest is resilient', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row_${i}` }));
        await dataMgr.put('atomic_tbl', rows);

        const manifestFile = path.join(tmpDir, 'atomic_tbl', 'manifest.json');
        const tmpManifest = path.join(tmpDir, 'atomic_tbl', 'manifest.json.tmp.999');

        fs.writeFileSync(tmpManifest, 'invalid json content');

        const count = await dataMgr.count('atomic_tbl');
        expect(count).toBe(10);

        const readBack = await dataMgr.get('atomic_tbl');
        expect(readBack.length).toBe(10);
    });
});
