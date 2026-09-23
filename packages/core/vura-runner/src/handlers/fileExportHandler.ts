import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify';
// @ts-ignore
import * as parquet from 'parquetjs-lite';
const { data } = require('@vura-data-os/vura-io');
import { DuckDbManager } from '../services/duckDbManager';
import { IVuraEnvironment, ICellLogger } from '../interfaces';

export interface ExportResult {
    buffer: Buffer;
    mime: string;
    filename: string;
}

const SUPPORTED_FORMATS = ['xlsx', 'csv', 'json', 'parquet'];

export async function generateExportBuffer(
    records: any[],
    formatRaw: string,
    tableName: string
): Promise<ExportResult> {
    const format = formatRaw.trim().toLowerCase();
    if (!SUPPORTED_FORMATS.includes(format)) {
        throw new Error(`Unsupported export format: "${formatRaw}". Supported formats are: ${SUPPORTED_FORMATS.join(', ')}.`);
    }

    const normalizedRecords = (records || []).map(row => {
        if (!row || typeof row !== 'object') return row;
        const out: any = {};
        for (const [k, v] of Object.entries(row)) {
            if (typeof v === 'bigint') {
                out[k] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number(v)
                    : v.toString();
            } else {
                out[k] = v;
            }
        }
        return out;
    });

    const filename = `${tableName}.${format}`;

    if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(tableName);
        if (normalizedRecords.length > 0 && normalizedRecords[0] && typeof normalizedRecords[0] === 'object') {
            worksheet.columns = Object.keys(normalizedRecords[0]).map(k => ({ header: k, key: k, width: 20 }));
            normalizedRecords.forEach(r => worksheet.addRow(r));
        }
        const arrayBuf = await workbook.xlsx.writeBuffer();
        return {
            buffer: Buffer.from(arrayBuf),
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            filename
        };
    }

    if (format === 'csv') {
        const csvBuffer = await new Promise<Buffer>((resolve, reject) => {
            stringify(normalizedRecords, { header: true }, (err, output) => {
                if (err) reject(err);
                else resolve(Buffer.from(output || '', 'utf8'));
            });
        });
        return {
            buffer: csvBuffer,
            mime: 'text/csv',
            filename
        };
    }

    if (format === 'json') {
        const jsonBuffer = Buffer.from(JSON.stringify(normalizedRecords, null, 2), 'utf8');
        return {
            buffer: jsonBuffer,
            mime: 'application/json',
            filename
        };
    }

    // Parquet
    const tmpPath = path.join(os.tmpdir(), `vura_export_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.parquet`);
    try {
        const schemaObj: any = {};
        if (normalizedRecords.length > 0 && normalizedRecords[0] && typeof normalizedRecords[0] === 'object') {
            for (const k of Object.keys(normalizedRecords[0])) {
                let type = 'UTF8';
                const sample = normalizedRecords[0][k];
                if (typeof sample === 'number') {
                    type = Number.isInteger(sample) ? 'INT64' : 'DOUBLE';
                } else if (typeof sample === 'boolean') {
                    type = 'BOOLEAN';
                }
                schemaObj[k] = { type, optional: true };
            }
        } else {
            schemaObj['_vura_dummy'] = { type: 'UTF8', optional: true };
        }
        const schema = new parquet.ParquetSchema(schemaObj);
        const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
        for (const row of normalizedRecords) {
            await writer.appendRow(row);
        }
        await writer.close();
        const parquetBuffer = await fs.promises.readFile(tmpPath);
        return {
            buffer: parquetBuffer,
            mime: 'application/vnd.apache.parquet',
            filename
        };
    } finally {
        await fs.promises.unlink(tmpPath).catch(() => {});
    }
}

export async function handleFileExport(
    sourceTable: string,
    format: string,
    outputTable: string,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    if (env.storagePath) {
        data.setStoragePath(env.storagePath);
    }

    const duckDb = await DuckDbManager.getInstance(env);

    let records: any[] = [];
    try {
        records = await duckDb.runQuery(`SELECT * FROM "${sourceTable}"`);
    } catch (err: any) {
        throw new Error(`Table "${sourceTable}" not found in local DuckDB: ${err.message}`);
    }

    const { buffer, mime, filename } = await generateExportBuffer(records, format, outputTable);

    const writtenPaths = await data.put(outputTable, [{
        filename,
        mime,
        bytes: buffer
    }]);

    const arrowPath = path.join(env.storagePath, `${outputTable}.arrow`);
    const parquetPath = path.join(env.storagePath, `${outputTable}.parquet`);
    const manifestPath = path.join(env.storagePath, outputTable, 'manifest.json');

    if (fs.existsSync(arrowPath)) {
        await duckDb.updateView(outputTable, arrowPath);
    } else if (fs.existsSync(parquetPath)) {
        await duckDb.updateView(outputTable, parquetPath);
    } else if (fs.existsSync(manifestPath)) {
        await duckDb.updateView(outputTable, manifestPath);
    } else {
        await duckDb.syncStorageViews(env);
    }
    await logger.logText(`Exported table "${sourceTable}" as ${format.toUpperCase()} into binary output table "${outputTable}".`);
}
