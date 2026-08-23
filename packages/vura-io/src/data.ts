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

export interface StreamOptions {
    batchSize?: number;
    format?: 'object' | 'arrow';
}

export interface UpdateOptions {
    on: string | string[];
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

    private async writeTableData(tableName: string, records: any): Promise<string> {
        let rawRecords: any[];
        if (records && typeof records === 'object' && (records.constructor?.name === 'Table' || typeof (records as any).toArray === 'function')) {
            rawRecords = (records as any).toArray();
        } else {
            rawRecords = (!records || (Array.isArray(records) && records.length === 0))
                ? [{ _vura_id: null, _vura_parent_id: null, _vura_index: null, _vura_value: null }]
                : (Array.isArray(records) ? records : [records]);
        }

        const schemaMap: Record<string, string> = {};
        for (const r of rawRecords) {
            if (r && typeof r === 'object') {
                for (const [k, v] of Object.entries(r)) {
                    if (!schemaMap[k] || schemaMap[k] === 'VARCHAR') {
                        if (v === null || v === undefined) {
                            if (!schemaMap[k]) schemaMap[k] = 'VARCHAR';
                        } else if (typeof v === 'boolean') {
                            schemaMap[k] = 'BOOLEAN';
                        } else if (typeof v === 'number') {
                            schemaMap[k] = Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
                        } else if (typeof v === 'bigint') {
                            schemaMap[k] = 'BIGINT';
                        } else if (v instanceof Date) {
                            schemaMap[k] = 'TIMESTAMP';
                        } else {
                            schemaMap[k] = 'VARCHAR';
                        }
                    } else if (schemaMap[k] === 'BIGINT' && typeof v === 'number' && !Number.isInteger(v)) {
                        schemaMap[k] = 'DOUBLE';
                    }
                }
            }
        }

        if (Object.keys(schemaMap).length === 0) {
            schemaMap['_vura_value'] = 'VARCHAR';
        }

        const conn = await this.getDuckDbConn();
        const tempTableName = `_temp_write_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const colDefs = Object.entries(schemaMap).map(([k, t]) => `"${k}" ${t}`).join(', ');
        await conn.runAndReadAll(`CREATE TEMP TABLE "${tempTableName}" (${colDefs})`);

        const appender = await conn.createAppender(tempTableName, 'main');
        const keys = Object.keys(schemaMap);

        for (const r of rawRecords) {
            for (const k of keys) {
                const val = r ? r[k] : null;
                const type = schemaMap[k];
                if (val === null || val === undefined) {
                    appender.appendNull();
                } else if (type === 'BIGINT') {
                    if (typeof val === 'number' && !Number.isInteger(val)) {
                        appender.appendDouble(val);
                    } else {
                        appender.appendBigInt(BigInt(Math.trunc(Number(val))));
                    }
                } else if (type === 'DOUBLE') {
                    appender.appendDouble(Number(val));
                } else if (type === 'BOOLEAN') {
                    appender.appendBoolean(Boolean(val));
                } else if (type === 'TIMESTAMP' && val instanceof Date) {
                    appender.appendVarchar(val.toISOString());
                } else {
                    appender.appendVarchar(typeof val === 'object' ? JSON.stringify(val) : String(val));
                }
            }
            appender.endRow();
        }
        appender.flushSync();
        appender.closeSync();

        const parquetPath = this.getTablePath(tableName, 'parquet');
        const safeTarget = parquetPath.replace(/\\/g, '/');
        await conn.runAndReadAll(`COPY "${tempTableName}" TO '${safeTarget}' (FORMAT PARQUET)`);
        await conn.runAndReadAll(`DROP TABLE IF EXISTS "${tempTableName}"`);

        const legacyArrow = this.getTablePath(tableName, 'arrow');
        if (fs.existsSync(legacyArrow)) {
            await fs.promises.unlink(legacyArrow).catch(() => {});
        }

        return parquetPath;
    }

    private async readTableData(tableName: string): Promise<any[]> {
        const tableInfo = this.findExistingTablePath(tableName);
        if (!tableInfo) return [];

        const conn = await this.getDuckDbConn();
        const safePath = tableInfo.filePath.replace(/\\/g, '/');
        let readQuery = tableInfo.format === 'arrow'
            ? `SELECT * FROM read_parquet('${safePath}')`
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
            const writtenPath = await this.writeTableData(tableName, records);
            this.emitMapping(tableName, writtenPath);
        }

        const metaTableName = `__vura_meta_${name}`;
        const metaRecords = [{ manifest: JSON.stringify(manifest) }];
        await this.writeTableData(metaTableName, metaRecords);

        const rootTableInfo = this.findExistingTablePath(name);
        const rootPath = rootTableInfo ? rootTableInfo.filePath : this.getTablePath(name, 'parquet');
        this.emitMapping(name, rootPath);

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
        if (obj && typeof obj === 'object' && (obj.constructor?.name === 'Table' || typeof obj.toArray === 'function')) {
            const writtenPath = await this.writeTableData(name, obj);
            this.emitMapping(name, writtenPath);
            return [name];
        }

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
        const writtenPath = await this.writeTableData(name, records);
        this.emitMapping(name, writtenPath);
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

    public async count(name: string): Promise<number> {
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) return 0;
        const conn = await this.getDuckDbConn();
        const safePath = tableInfo.filePath.replace(/\\/g, '/');
        const reader = await conn.runAndReadAll(`SELECT COUNT(*)::BIGINT as total FROM read_parquet('${safePath}')`);
        const rows = reader.getRows();
        if (rows.length > 0 && rows[0][0] !== null) {
            return Number(rows[0][0]);
        }
        return 0;
    }

    public async *stream(name: string, options?: StreamOptions): AsyncGenerator<any[], void, unknown> {
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) return;

        const batchSize = options?.batchSize && options.batchSize > 0 ? options.batchSize : 50000;
        const total = await this.count(name);
        if (total === 0) return;

        const conn = await this.getDuckDbConn();
        const safePath = tableInfo.filePath.replace(/\\/g, '/');

        for (let offset = 0; offset < total; offset += batchSize) {
            const query = `SELECT * FROM read_parquet('${safePath}') LIMIT ${batchSize} OFFSET ${offset}`;
            const reader = await conn.runAndReadAll(query);

            const colNames = reader.columnNames();
            const rows = reader.getRows();
            const numCols = colNames.length;
            const chunk = new Array(rows.length);

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const obj: Record<string, any> = {};
                for (let j = 0; j < numCols; j++) {
                    const val = row[j];
                    obj[colNames[j]] = val === null || val === undefined ? null : normalizeValue(val);
                }
                chunk[i] = obj;
            }
            yield chunk;
        }
    }

    public async append(name: string, obj: any): Promise<string[]> {
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) {
            return await this.put(name, obj);
        }

        const rawRecords = Array.isArray(obj) ? obj : [obj];
        if (rawRecords.length === 0) return [name];

        const targetPath = tableInfo.filePath.replace(/\\/g, '/');
        const conn = await this.getDuckDbConn();

        const tempTableName = `_temp_append_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const writtenTempPath = await this.writeTableData(tempTableName, rawRecords);
        const tempSafePath = writtenTempPath.replace(/\\/g, '/');

        const combinedTempName = `_temp_combined_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await conn.runAndReadAll(`
            CREATE TEMP TABLE "${combinedTempName}" AS 
            SELECT * FROM read_parquet('${targetPath}') 
            UNION ALL BY NAME 
            SELECT * FROM read_parquet('${tempSafePath}')
        `);

        const parquetPath = this.getTablePath(name, 'parquet');
        const safeTarget = parquetPath.replace(/\\/g, '/');
        await conn.runAndReadAll(`COPY "${combinedTempName}" TO '${safeTarget}' (FORMAT PARQUET)`);
        await conn.runAndReadAll(`DROP TABLE IF EXISTS "${combinedTempName}"`);

        if (fs.existsSync(writtenTempPath)) {
            await fs.promises.unlink(writtenTempPath).catch(() => {});
        }

        this.emitMapping(name, parquetPath);
        return [name];
    }

    public async update(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) {
            throw new Error(`Table '${name}' does not exist to update.`);
        }

        const rawRecords = Array.isArray(records) ? records : [records];
        if (rawRecords.length === 0) return [name];

        const keys = Array.isArray(options.on) ? options.on : [options.on];
        if (keys.length === 0) {
            throw new Error("Update requires at least one key specified in 'on'.");
        }

        const targetPath = tableInfo.filePath.replace(/\\/g, '/');
        const conn = await this.getDuckDbConn();

        const stageName = `_temp_stage_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const writtenStagePath = await this.writeTableData(stageName, rawRecords);
        const stageSafePath = writtenStagePath.replace(/\\/g, '/');

        const targetTempName = `_temp_target_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await conn.runAndReadAll(`CREATE TEMP TABLE "${targetTempName}" AS SELECT * FROM read_parquet('${targetPath}')`);

        const stageReader = await conn.runAndReadAll(`SELECT * FROM read_parquet('${stageSafePath}') LIMIT 1`);
        const stageCols = stageReader.columnNames();
        const nonKeyCols = stageCols.filter(c => !keys.includes(c));

        if (nonKeyCols.length > 0) {
            const setClause = nonKeyCols.map(c => `"${c}" = s."${c}"`).join(', ');
            const joinCond = keys.map(k => `t."${k}" = s."${k}"`).join(' AND ');

            await conn.runAndReadAll(`
                UPDATE "${targetTempName}" AS t
                SET ${setClause}
                FROM read_parquet('${stageSafePath}') AS s
                WHERE ${joinCond}
            `);
        }

        const parquetPath = this.getTablePath(name, 'parquet');
        const safeTarget = parquetPath.replace(/\\/g, '/');
        await conn.runAndReadAll(`COPY "${targetTempName}" TO '${safeTarget}' (FORMAT PARQUET)`);
        await conn.runAndReadAll(`DROP TABLE IF EXISTS "${targetTempName}"`);

        if (fs.existsSync(writtenStagePath)) {
            await fs.promises.unlink(writtenStagePath).catch(() => {});
        }

        this.emitMapping(name, parquetPath);
        return [name];
    }

    public async upsert(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) {
            return await this.put(name, records);
        }

        const rawRecords = Array.isArray(records) ? records : [records];
        if (rawRecords.length === 0) return [name];

        const keys = Array.isArray(options.on) ? options.on : [options.on];
        if (keys.length === 0) {
            throw new Error("Upsert requires at least one key specified in 'on'.");
        }

        const targetPath = tableInfo.filePath.replace(/\\/g, '/');
        const conn = await this.getDuckDbConn();

        const stageName = `_temp_stage_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const writtenStagePath = await this.writeTableData(stageName, rawRecords);
        const stageSafePath = writtenStagePath.replace(/\\/g, '/');

        const targetTempName = `_temp_target_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await conn.runAndReadAll(`CREATE TEMP TABLE "${targetTempName}" AS SELECT * FROM read_parquet('${targetPath}')`);

        const stageReader = await conn.runAndReadAll(`SELECT * FROM read_parquet('${stageSafePath}') LIMIT 1`);
        const stageCols = stageReader.columnNames();
        const nonKeyCols = stageCols.filter(c => !keys.includes(c));

        const joinCond = keys.map(k => `t."${k}" = s."${k}"`).join(' AND ');
        const updateSetClause = nonKeyCols.map(c => `"${c}" = s."${c}"`).join(', ');
        const insertColsClause = stageCols.map(c => `"${c}"`).join(', ');
        const insertValsClause = stageCols.map(c => `s."${c}"`).join(', ');

        const updatePart = nonKeyCols.length > 0 ? `WHEN MATCHED THEN UPDATE SET ${updateSetClause}` : '';

        await conn.runAndReadAll(`
            MERGE INTO "${targetTempName}" AS t
            USING read_parquet('${stageSafePath}') AS s
            ON ${joinCond}
            ${updatePart}
            WHEN NOT MATCHED THEN INSERT (${insertColsClause}) VALUES (${insertValsClause})
        `);

        const parquetPath = this.getTablePath(name, 'parquet');
        const safeTarget = parquetPath.replace(/\\/g, '/');
        await conn.runAndReadAll(`COPY "${targetTempName}" TO '${safeTarget}' (FORMAT PARQUET)`);
        await conn.runAndReadAll(`DROP TABLE IF EXISTS "${targetTempName}"`);

        if (fs.existsSync(writtenStagePath)) {
            await fs.promises.unlink(writtenStagePath).catch(() => {});
        }

        this.emitMapping(name, parquetPath);
        return [name];
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

