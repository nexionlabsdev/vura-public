import * as fs from 'fs';
import * as path from 'path';
import * as arrow from 'apache-arrow';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { shredJson, unshredJson, Manifest } from './shredder';

function normalizeValue(val: any): any {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
        return val;
    }
    if (typeof val === 'bigint') {
        const num = Number(val);
        return Number.isSafeInteger(num) ? num : val.toString();
    }
    if (typeof val.toUUID === 'function') {
        return val.toUUID();
    }
    if (val.constructor && val.constructor.name === 'DuckDBUUIDValue') {
        return val.toString();
    }
    if (typeof val.scale === 'number' && (typeof val.value === 'bigint' || typeof val.value === 'number')) {
        return Number(val.value) / Math.pow(10, val.scale);
    }
    if (val instanceof Date) return val.toISOString();
    if (typeof val.micros === 'bigint') {
        return new Date(Number(val.micros / 1000n)).toISOString();
    }
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
        if (val.length === 16) {
            const hex = Array.from(val, b => b.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        return Array.from(val);
    }
    if (typeof val === 'object') {
        if (val.entries && typeof val.entries === 'object') {
            const res: Record<string, any> = {};
            for (const [k, v] of Object.entries(val.entries)) {
                res[k] = normalizeValue(v);
            }
            return res;
        }
        if (Array.isArray(val)) {
            return val.map(normalizeValue);
        }
        if (typeof val.toJSON === 'function') {
            return val.toJSON();
        }
        const res: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
            res[k] = normalizeValue(v);
        }
        return res;
    }
    return val;
}

export class DataManager {
    private storagePath: string;
    private manifests: Map<string, Manifest> = new Map();
    private duckDbInstance?: DuckDBInstance;
    private duckDbConn?: DuckDBConnection;

    constructor(storagePath?: string) {
        this.storagePath = storagePath || process.env.VURA_STORAGE_PATH || process.cwd();
    }

    public setStoragePath(p: string) {
        this.storagePath = p;
    }

    private get currentStoragePath(): string {
        return process.env.VURA_STORAGE_PATH || this.storagePath;
    }

    private get thresholdBytes(): number {
        const envVal = process.env.VURA_ARROW_THRESHOLD_BYTES;
        if (envVal) {
            const parsed = parseInt(envVal, 10);
            if (!isNaN(parsed) && parsed >= 0) return parsed;
        }
        return 5 * 1024 * 1024; // Default 5 MB
    }

    private getTablePath(tableName: string, ext: 'arrow' | 'parquet'): string {
        return path.join(this.currentStoragePath, `${tableName}.${ext}`);
    }

    private findExistingTablePath(tableName: string): { filePath: string; format: 'arrow' | 'parquet' } | null {
        let baseName = tableName.replace(/\.(arrow|parquet)$/, '');
        let arrowPath = this.getTablePath(baseName, 'arrow');
        let parquetPath = this.getTablePath(baseName, 'parquet');

        if (fs.existsSync(arrowPath)) return { filePath: arrowPath, format: 'arrow' };
        if (fs.existsSync(parquetPath)) return { filePath: parquetPath, format: 'parquet' };

        if (fs.existsSync(this.currentStoragePath)) {
            const files = fs.readdirSync(this.currentStoragePath);
            const lowerBase = baseName.toLowerCase();
            const foundArrow = files.find(f => f.toLowerCase() === `${lowerBase}.arrow`);
            if (foundArrow) return { filePath: path.join(this.currentStoragePath, foundArrow), format: 'arrow' };
            const foundParquet = files.find(f => f.toLowerCase() === `${lowerBase}.parquet`);
            if (foundParquet) return { filePath: path.join(this.currentStoragePath, foundParquet), format: 'parquet' };
        }
        return null;
    }

    private emitMapping(variableName: string, filePath: string) {
        process.stderr.write(JSON.stringify({ type: 'vura_io_mapping', variable: variableName, path: filePath }) + '\n');
    }

    private async getDuckDbConn(): Promise<DuckDBConnection> {
        if (!this.duckDbConn) {
            this.duckDbInstance = await DuckDBInstance.create(':memory:');
            this.duckDbConn = await this.duckDbInstance.connect();
        }
        return this.duckDbConn;
    }

    private async writeTableData(tableName: string, records: any[]): Promise<string> {
        const recordsToWrite = (!records || records.length === 0)
            ? [{ _vura_id: null, _vura_parent_id: null, _vura_index: null, _vura_value: null }]
            : records;

        const jsonStr = JSON.stringify(recordsToWrite, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        const parquetPath = this.getTablePath(tableName, 'parquet');
        const conn = await this.getDuckDbConn();
        const tempJson = path.join(this.currentStoragePath, `_temp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.json`);
        await fs.promises.writeFile(tempJson, jsonStr, 'utf8');

        try {
            const safeTemp = tempJson.replace(/\\/g, '/');
            const safeTarget = parquetPath.replace(/\\/g, '/');
            await conn.runAndReadAll(`COPY (SELECT * FROM read_json_auto('${safeTemp}')) TO '${safeTarget}' (FORMAT PARQUET)`);
        } finally {
            await fs.promises.unlink(tempJson).catch(() => {});
        }

        return parquetPath;
    }

    private async readTableData(tableName: string): Promise<any[]> {
        const tableInfo = this.findExistingTablePath(tableName);
        if (!tableInfo) return [];

        const conn = await this.getDuckDbConn();
        const safePath = tableInfo.filePath.replace(/\\/g, '/');
        let readQuery = tableInfo.format === 'arrow'
            ? `SELECT * FROM read_ipc('${safePath}')`
            : `SELECT * FROM read_parquet('${safePath}')`;

        let reader;
        try {
            reader = await conn.runAndReadAll(readQuery);
        } catch (e) {
            if (tableInfo.format === 'arrow') {
                const fallbackParquet = this.getTablePath(tableName.replace(/\.arrow$/, ''), 'parquet');
                if (fs.existsSync(fallbackParquet)) {
                    reader = await conn.runAndReadAll(`SELECT * FROM read_parquet('${fallbackParquet.replace(/\\/g, '/')}')`);
                } else {
                    throw e;
                }
            } else {
                throw e;
            }
        }

        const colNames = reader.columnNames();
        const rows = reader.getRows();
        const numCols = colNames.length;
        const result = new Array(rows.length);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const obj: Record<string, any> = {};
            for (let j = 0; j < numCols; j++) {
                const val = row[j];
                if (val === null || val === undefined) {
                    obj[colNames[j]] = null;
                } else {
                    obj[colNames[j]] = normalizeValue(val);
                }
            }
            result[i] = obj;
        }
        return result;
    }

    public async pack(name: string, obj: any): Promise<string[]> {
        const { tables, manifest, tableNames } = shredJson(name, obj);
        this.manifests.set(name, manifest);

        for (const [tableName, records] of Object.entries(tables)) {
            await this.writeTableData(tableName, records);
            const parquetPath = this.getTablePath(tableName, 'parquet');
            this.emitMapping(tableName, parquetPath);
        }

        const metaTableName = `__vura_meta_${name}`;
        const metaRecords = [{ manifest: JSON.stringify(manifest) }];
        await this.writeTableData(metaTableName, metaRecords);

        const rootParquetPath = this.getTablePath(name, 'parquet');
        this.emitMapping(name, rootParquetPath);

        return tableNames;
    }

    public async unpack(name: string): Promise<any> {
        let manifest = this.manifests.get(name);
        if (!manifest) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableData(metaTableName);
            if (!metaRecords || metaRecords.length === 0 || !metaRecords[0].manifest) {
                throw new Error(`Dataset metadata for '${name}' not found.`);
            }
            manifest = JSON.parse(metaRecords[0].manifest);
            this.manifests.set(name, manifest!);
        }

        const tables: Record<string, any[]> = {};
        for (const tableName of Object.keys(manifest!.tables)) {
            tables[tableName] = await this.readTableData(tableName);
        }

        return unshredJson(manifest!, tables);
    }

    public async put(name: string, obj: any): Promise<string[]> {
        const isNested = (val: any): boolean => {
            if (!val || typeof val !== 'object') return false;
            if (Array.isArray(val)) {
                return val.some(item => item && typeof item === 'object');
            }
            return Object.values(val).some(v => v && typeof v === 'object');
        };

        if (isNested(obj)) {
            return await this.pack(name, obj);
        }

        const records = Array.isArray(obj) ? obj : [obj];
        await this.writeTableData(name, records);
        const parquetPath = this.getTablePath(name, 'parquet');
        this.emitMapping(name, parquetPath);
        return [name];
    }

    public async get(name: string): Promise<any> {
        const metaTableName = `__vura_meta_${name}`;
        const metaInfo = this.findExistingTablePath(metaTableName);
        if (metaInfo || this.manifests.has(name)) {
            return await this.unpack(name);
        }
        return await this.readTableData(name);
    }

    public async tables(name?: string): Promise<string[]> {
        if (name) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableData(metaTableName);
            if (metaRecords && metaRecords.length > 0 && metaRecords[0].manifest) {
                const manifest: Manifest = JSON.parse(metaRecords[0].manifest);
                return Object.keys(manifest.tables);
            }
            return [name];
        }

        if (!fs.existsSync(this.currentStoragePath)) return [];
        return fs.readdirSync(this.currentStoragePath)
            .filter(f => (f.endsWith('.parquet') || f.endsWith('.arrow')))
            .map(f => f.replace(/\.(parquet|arrow)$/, ''))
            .filter(f => !f.startsWith('__vura_meta_'));
    }
}

export const data = new DataManager();
