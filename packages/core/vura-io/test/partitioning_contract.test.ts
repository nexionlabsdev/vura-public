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
        delete process.env.VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND;
        delete process.env.VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE;
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
        const partsFile = path.join(tmpDir, 'test_tbl', 'manifest-parts.jsonl');
        const part0 = path.join(tmpDir, 'test_tbl', 'part-0000.parquet');

        expect(fs.existsSync(manifestFile)).toBe(true);
        expect(fs.existsSync(partsFile)).toBe(true);
        expect(fs.existsSync(part0)).toBe(true);
        expect(fs.existsSync(arrowFile)).toBe(false);

        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        expect(manifest.version).toBe(1);
        expect(manifest.rowCount).toBe(10);
        expect(manifest.nextPartIndex).toBe(1);
        expect(manifest.parts).toBeUndefined();

        const partsLines = fs.readFileSync(partsFile, 'utf8').trim().split('\n');
        expect(partsLines.length).toBe(1);
        const part0Log = JSON.parse(partsLines[0]);
        expect(part0Log.file).toBe('part-0000.parquet');
        expect(part0Log.rowCount).toBe(10);

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
        const partsFile = path.join(tmpDir, 'mig_tbl', 'manifest-parts.jsonl');
        const part0 = path.join(tmpDir, 'mig_tbl', 'part-0000.parquet');
        const part1 = path.join(tmpDir, 'mig_tbl', 'part-0001.parquet');

        expect(fs.existsSync(manifestFile)).toBe(true);
        expect(fs.existsSync(partsFile)).toBe(true);
        expect(fs.existsSync(part0)).toBe(true);
        expect(fs.existsSync(part1)).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        expect(manifest.rowCount).toBe(11);
        expect(manifest.nextPartIndex).toBe(2);

        const partsLines = fs.readFileSync(partsFile, 'utf8').trim().split('\n');
        expect(partsLines.length).toBe(2);

        const readBack = await dataMgr.get('mig_tbl');
        expect(readBack.length).toBe(11);
    });

    test('update/upsert against partitioned table truncates manifest-parts.jsonl to 1 entry', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row_${i}` }));
        await dataMgr.put('upd_tbl', rows);

        await dataMgr.append('upd_tbl', Array.from({ length: 10 }, (_, i) => ({ id: i + 10, name: `row_${i + 10}` })));
        await dataMgr.flush('upd_tbl');

        const partsFile = path.join(tmpDir, 'upd_tbl', 'manifest-parts.jsonl');
        expect(fs.readFileSync(partsFile, 'utf8').trim().split('\n').length).toBe(2);

        await dataMgr.update('upd_tbl', { id: 0, name: 'updated_0' }, { on: 'id' });

        const partsAfterUpdate = fs.readFileSync(partsFile, 'utf8').trim().split('\n');
        expect(partsAfterUpdate.length).toBe(1);

        const manifestAfterUpdate = JSON.parse(fs.readFileSync(path.join(tmpDir, 'upd_tbl', 'manifest.json'), 'utf8'));
        expect(manifestAfterUpdate.nextPartIndex).toBe(1);

        const readBack = await dataMgr.get('upd_tbl');
        expect(readBack.length).toBe(20);
        expect(readBack.find((r: any) => r.id === 0).name).toBe('updated_0');
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

    test('isolated atomic rename unit test: failure during rename leaves manifest untouched', async () => {
        const initialManifest = { version: 1, tableName: 'rename_tbl', rowCount: 10, nextPartIndex: 1, schema: { id: 'BIGINT' } };
        await (dataMgr as any).saveManifestAtomically('rename_tbl', initialManifest);

        const manifestFile = path.join(tmpDir, 'rename_tbl', 'manifest.json');
        expect(fs.existsSync(manifestFile)).toBe(true);

        const updatedManifest = { version: 1, tableName: 'rename_tbl', rowCount: 20, nextPartIndex: 2, schema: { id: 'BIGINT' } };

        jest.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
            throw new Error('Simulated atomic rename I/O failure');
        });

        await expect((dataMgr as any).saveManifestAtomically('rename_tbl', updatedManifest)).rejects.toThrow('Simulated atomic rename I/O failure');

        const savedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        expect(savedManifest.rowCount).toBe(10);
        expect(savedManifest.nextPartIndex).toBe(1);
    });
});
