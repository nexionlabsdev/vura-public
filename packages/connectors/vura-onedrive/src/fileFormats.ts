import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// @ts-ignore
import * as parquet from 'parquetjs-lite';
import * as ExcelJS from 'exceljs';
import { IVuraEnvironment } from '@vura-data-os/core-sdk';

export const SUPPORTED_EXPORT_FORMATS = ['csv', 'json', 'parquet', 'xlsx'];
export const SUPPORTED_IMPORT_FORMATS = ['csv', 'json', 'parquet', 'excel'];

function normalizeRecords(records: any[]): any[] {
    return (records || []).map(row => {
        if (!row || typeof row !== 'object') return row;
        const out: any = {};
        for (const [k, v] of Object.entries(row)) {
            out[k] = typeof v === 'bigint'
                ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString())
                : v;
        }
        return out;
    });
}

export async function recordsToBuffer(records: any[], format: string): Promise<Buffer> {
    const normalized = normalizeRecords(records);
    const f = format.trim().toLowerCase();
    if (!SUPPORTED_EXPORT_FORMATS.includes(f)) {
        throw new Error(`Unsupported export format "${format}". Supported formats: ${SUPPORTED_EXPORT_FORMATS.join(', ')}.`);
    }

    if (f === 'json') {
        return Buffer.from(JSON.stringify(normalized, null, 2), 'utf8');
    }

    if (f === 'csv') {
        if (normalized.length === 0) return Buffer.from('', 'utf8');
        const headers = Object.keys(normalized[0]);
        const esc = (v: any) => {
            if (v === null || v === undefined) return '';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [headers.join(',')];
        for (const row of normalized) lines.push(headers.map(h => esc(row[h])).join(','));
        return Buffer.from(lines.join('\n'), 'utf8');
    }

    if (f === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('data');
        if (normalized.length > 0) {
            worksheet.columns = Object.keys(normalized[0]).map(k => ({ header: k, key: k, width: 20 }));
            normalized.forEach(r => worksheet.addRow(r));
        }
        const arrayBuf = await workbook.xlsx.writeBuffer();
        return Buffer.from(arrayBuf);
    }

    // parquet
    const tmpPath = path.join(os.tmpdir(), `vura_export_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.parquet`);
    try {
        const schemaObj: any = {};
        if (normalized.length > 0) {
            for (const k of Object.keys(normalized[0])) {
                const sample = normalized[0][k];
                let type = 'UTF8';
                if (typeof sample === 'number') type = Number.isInteger(sample) ? 'INT64' : 'DOUBLE';
                else if (typeof sample === 'boolean') type = 'BOOLEAN';
                schemaObj[k] = { type, optional: true };
            }
        } else {
            schemaObj['_vura_dummy'] = { type: 'UTF8', optional: true };
        }
        const schema = new parquet.ParquetSchema(schemaObj);
        const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
        for (const row of normalized) await writer.appendRow(row);
        await writer.close();
        return await fs.promises.readFile(tmpPath);
    } finally {
        await fs.promises.unlink(tmpPath).catch(() => {});
    }
}

/**
 * Loads downloaded file bytes into a local DuckDB table via env.runLocalQuery.
 * Add-ons only get SQL-level access to the shared DuckDB instance (no direct
 * bulk-insert API), so CSV/JSON/Parquet are loaded by pointing DuckDB's native
 * readers at a temp file; XLSX is parsed with exceljs into row objects first,
 * written out as temp JSON, then loaded the same way.
 */
export async function loadBufferIntoTable(env: IVuraEnvironment, buffer: Buffer, format: string, targetTable: string): Promise<number> {
    const f = format.trim().toLowerCase();
    if (!SUPPORTED_IMPORT_FORMATS.includes(f)) {
        throw new Error(`Unsupported import format "${format}". Supported formats: ${SUPPORTED_IMPORT_FORMATS.join(', ')}.`);
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vura-import-'));
    try {
        if (f === 'excel') {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(buffer as any);
            const worksheet = workbook.worksheets[0];
            if (!worksheet) throw new Error('No worksheet found in the Excel file.');
            const headers: string[] = [];
            worksheet.getRow(1).eachCell((cell, colNumber) => { headers[colNumber] = cell.value?.toString() || `Col${colNumber}`; });
            const records: any[] = [];
            worksheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return;
                const rowData: any = {};
                row.eachCell((cell, colNumber) => { rowData[headers[colNumber]] = cell.value; });
                records.push(rowData);
            });
            const jsonPath = path.join(tmpDir, 'data.json');
            await fs.promises.writeFile(jsonPath, JSON.stringify(records), 'utf8');
            await env.runLocalQuery(`CREATE OR REPLACE TABLE "${targetTable}" AS SELECT * FROM read_json_auto('${jsonPath.replace(/\\/g, '/')}')`);
            return records.length;
        }

        const ext = f === 'json' ? 'json' : f === 'parquet' ? 'parquet' : 'csv';
        const filePath = path.join(tmpDir, `data.${ext}`);
        await fs.promises.writeFile(filePath, buffer);
        const safePath = filePath.replace(/\\/g, '/');

        const readExpr = f === 'json' ? `read_json_auto('${safePath}')`
            : f === 'parquet' ? `read_parquet('${safePath}')`
            : `read_csv_auto('${safePath}')`;

        await env.runLocalQuery(`CREATE OR REPLACE TABLE "${targetTable}" AS SELECT * FROM ${readExpr}`);
        const countRows = await env.runLocalQuery(`SELECT COUNT(*) AS c FROM "${targetTable}"`);
        return Number(countRows[0]?.c || 0);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}
