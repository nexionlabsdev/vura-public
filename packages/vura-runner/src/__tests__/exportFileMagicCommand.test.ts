import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DuckDbManager } from '../services/duckDbManager';
import { CliEnvironment } from '../cliEnvironment';
import { handleTerminal } from '../handlers/terminalHandler';
const { generateExportBuffer, handleFileExport } = require('../handlers/fileExportHandler');
const { data } = require('@vura-data-os/vura-io');

describe('Phase 8: !export-file magic command & file export handler', () => {
    let tempDir: string;
    let loggerLogs: string[];
    let loggerErrors: string[];

    const mockLogger = {
        logText: async (msg: string) => { loggerLogs.push(msg); },
        logError: async (msg: string) => { loggerErrors.push(msg); },
        replaceOutput: async () => {},
        appendHtmlOutput: async () => {},
        appendOutput: async () => {},
        logHtml: async () => {},
        logJson: async () => {},
        logMultiple: async () => {},
        clearOutput: async () => {}
    };

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-export-file-test-'));
        loggerLogs = [];
        loggerErrors = [];
        process.env.VURA_STORAGE_PATH = tempDir;
        data.setStoragePath(tempDir);
    });

    afterEach(async () => {
        DuckDbManager.disposeAll();
        delete process.env.VURA_STORAGE_PATH;
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('generateExportBuffer produces valid buffer output for all formats', async () => {
        const sampleRecords = [
            { id: 1, name: 'Alice', active: true, score: 95.5, big: BigInt(100) },
            { id: 2, name: 'Bob', active: false, score: 88.0, big: BigInt(200) }
        ];

        // XLSX
        const xlsxResult = await generateExportBuffer(sampleRecords, 'xlsx', 'test_table');
        expect(xlsxResult.filename).toBe('test_table.xlsx');
        expect(xlsxResult.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(xlsxResult.buffer.length).toBeGreaterThan(0);

        // CSV
        const csvResult = await generateExportBuffer(sampleRecords, 'csv', 'test_table');
        expect(csvResult.filename).toBe('test_table.csv');
        expect(csvResult.mime).toBe('text/csv');
        const csvText = csvResult.buffer.toString('utf8');
        expect(csvText).toContain('id,name,active,score,big');
        expect(csvText).toContain('Alice');
        expect(csvText).toContain('Bob');

        // JSON
        const jsonResult = await generateExportBuffer(sampleRecords, 'json', 'test_table');
        expect(jsonResult.filename).toBe('test_table.json');
        expect(jsonResult.mime).toBe('application/json');
        const parsedJson = JSON.parse(jsonResult.buffer.toString('utf8'));
        expect(parsedJson).toHaveLength(2);
        expect(parsedJson[0].name).toBe('Alice');

        // Parquet
        const parquetResult = await generateExportBuffer(sampleRecords, 'parquet', 'test_table');
        expect(parquetResult.filename).toBe('test_table.parquet');
        expect(parquetResult.mime).toBe('application/vnd.apache.parquet');
        expect(parquetResult.buffer.length).toBeGreaterThan(0);
    });

    it('executes !export-file via handleTerminal and creates binary table output in DuckDB & data manager', async () => {
        const env = new CliEnvironment(tempDir);
        env.storagePath = tempDir;
        const mgr = await DuckDbManager.getInstance(env);

        // Create source table in DuckDB
        await mgr.runQuery(`CREATE TABLE "my_source" (id INTEGER, city VARCHAR);`);
        await mgr.runQuery(`INSERT INTO "my_source" VALUES (10, 'Seattle'), (20, 'Portland');`);

        // Export via !export-file magic command in terminal cell
        const cell = {
            id: 'cell_1',
            kind: 2,
            language: 'vura-terminal',
            value: '!export-file my_source xlsx -> my_source_xlsx'
        };

        await handleTerminal(cell, env, mockLogger);

        // Verify output table exists in data.get()
        const tableData = await data.get('my_source_xlsx');
        expect(tableData).toHaveLength(1);
        expect(tableData[0].filename).toBe('my_source_xlsx.xlsx');
        expect(tableData[0].mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(tableData[0].bytes).toBeDefined();

        // Verify output table is queryable in DuckDB
        try {
            await mgr.syncStorageViews(env);
        } catch (e) {
            console.error('syncStorageViews error in test 2:', e);
        }
        try {
            const duckDbRows = await mgr.runQuery(`SELECT * FROM "my_source_xlsx"`);
            expect(duckDbRows).toHaveLength(1);
            expect(duckDbRows[0].filename).toBe('my_source_xlsx.xlsx');
        } catch (e) {
            console.error('runQuery error in test 2:', e);
            throw e;
        }
    });

    it('handles quoted table names and csv/json/parquet formats in !export-file command', async () => {
        const env = new CliEnvironment(tempDir);
        env.storagePath = tempDir;
        const mgr = await DuckDbManager.getInstance(env);

        await mgr.runQuery(`CREATE TABLE "user_data" (id INTEGER, username VARCHAR);`);
        await mgr.runQuery(`INSERT INTO "user_data" VALUES (1, 'john_doe');`);

        // Quoted source & target names
        const cellCsv = {
            id: 'cell_2',
            kind: 2,
            language: 'vura-terminal',
            value: '!export-file "user_data" csv -> "user_data_csv"'
        };
        await handleTerminal(cellCsv, env, mockLogger);

        const csvData = await data.get('user_data_csv');
        expect(csvData).toHaveLength(1);
        expect(csvData[0].filename).toBe('user_data_csv.csv');
        expect(csvData[0].mime).toBe('text/csv');
        const bytesRaw = csvData[0].bytes;
        const bytesBuffer = Buffer.isBuffer(bytesRaw) ? bytesRaw : (Array.isArray(bytesRaw) || bytesRaw instanceof Uint8Array ? Buffer.from(bytesRaw) : Buffer.from(Object.values(bytesRaw)));
        expect(bytesBuffer.toString('utf8')).toContain('john_doe');

        const cellJson = {
            id: 'cell_3',
            kind: 2,
            language: 'vura-terminal',
            value: '!export-file user_data json -> user_data_json'
        };
        await handleTerminal(cellJson, env, mockLogger);

        const jsonData = await data.get('user_data_json');
        expect(jsonData).toHaveLength(1);
        expect(jsonData[0].filename).toBe('user_data_json.json');
        expect(jsonData[0].mime).toBe('application/json');
    });

    it('throws error for unsupported export format or missing source table', async () => {
        const env = new CliEnvironment(tempDir);
        env.storagePath = tempDir;
        const cellInvalidFormat = {
            id: 'cell_4',
            kind: 2,
            language: 'vura-terminal',
            value: '!export-file nonexistent docx -> target_table'
        };

        await expect(handleTerminal(cellInvalidFormat, env, mockLogger)).rejects.toThrow('Invalid !export-file command syntax');

        const cellMissingTable = {
            id: 'cell_5',
            kind: 2,
            language: 'vura-terminal',
            value: '!export-file non_existent_table xlsx -> target_table'
        };

        await expect(handleTerminal(cellMissingTable, env, mockLogger)).rejects.toThrow('Table "non_existent_table" not found in local DuckDB');
    });
});
