import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DuckDbManager } from '../services/duckDbManager';
import { CliEnvironment } from '../cliEnvironment';

describe('Phase 7: Visual Output Export Table Naming', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-visual-export-test-'));
    });

    afterEach(async () => {
        DuckDbManager.disposeAll();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('creates cell_1_output_pdf table and exports parquet for cell index 0', async () => {
        const env = new CliEnvironment(tempDir);
        const mgr = await DuckDbManager.getInstance(env);

        const pdfPath = path.join(tempDir, 'test_output.pdf');
        const tableName = await mgr.registerVisualOutputTable(0, 'pdf', pdfPath, tempDir);

        expect(tableName).toBe('cell_1_output_pdf');

        const rows = await mgr.runQuery(`SELECT * FROM "${tableName}"`);
        expect(rows).toHaveLength(1);
        expect(rows[0].cell_index).toBe('cell_1');
        expect(rows[0].export_type).toBe('pdf');
        expect(rows[0].path).toBe(pdfPath.replace(/\\/g, '/'));

        // Verify Parquet file was created in storagePath
        const parquetPath = path.join(tempDir, `${tableName}.parquet`);
        const exists = await fs.stat(parquetPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
    });

    it('creates cell_2_output_png table for cell index 1', async () => {
        const env = new CliEnvironment(tempDir);
        const mgr = await DuckDbManager.getInstance(env);

        const pngPath = path.join(tempDir, 'test_output.png');
        const tableName = await mgr.registerVisualOutputTable(1, 'png', pngPath, env.storagePath);

        expect(tableName).toBe('cell_2_output_png');

        const rows = await mgr.runQuery(`SELECT * FROM "${tableName}"`);
        expect(rows).toHaveLength(1);
        expect(rows[0].cell_index).toBe('cell_2');
        expect(rows[0].export_type).toBe('png');
        expect(rows[0].path).toBe(pngPath.replace(/\\/g, '/'));
    });

    it('handles explicit string cell identifier like cell_3', async () => {
        const env = new CliEnvironment(tempDir);
        const mgr = await DuckDbManager.getInstance(env);

        const pdfPath = path.join(tempDir, 'report.pdf');
        const tableName = await mgr.registerVisualOutputTable('cell_3', 'pdf', pdfPath, env.storagePath);

        expect(tableName).toBe('cell_3_output_pdf');

        const rows = await mgr.runQuery(`SELECT * FROM "${tableName}"`);
        expect(rows).toHaveLength(1);
        expect(rows[0].cell_index).toBe('cell_3');
        expect(rows[0].export_type).toBe('pdf');
    });
});
