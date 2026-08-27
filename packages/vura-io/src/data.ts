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
    private bufferMap: Map<string, any[]> = new Map();

    constructor(storagePath?: string) {
        this.storagePath = storagePath || process.env.VURA_STORAGE_PATH || process.cwd();
    }

    public setStoragePath(p: string) {
        this.storagePath = p;
    }

    private get currentStoragePath(): string {
        return process.env.VURA_STORAGE_PATH || this.storagePath;
    }

    private get partitionThresholdRows(): number {
        const envVal = process.env.VURA_PARTITION_THRESHOLD_ROWS;
        if (envVal) {
            const parsed = parseInt(envVal, 10);
            if (!isNaN(parsed) && parsed >= 0) return parsed;
        }
        return 50000;
    }

    private getTablePath(tableName: string, ext: 'arrow' | 'parquet'): string {
        return path.join(this.currentStoragePath, `${tableName}.${ext}`);
    }

    private findExistingTablePath(tableName: string): { filePath: string; format: 'arrow' | 'parquet' | 'partitioned' } | null {
        let baseName = tableName.replace(/\.(arrow|parquet)$/, '');
        let manifestPath = path.join(this.currentStoragePath, baseName, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            return { filePath: manifestPath, format: 'partitioned' };
        }

        let arrowPath = this.getTablePath(baseName, 'arrow');
        let parquetPath = this.getTablePath(baseName, 'parquet');

        if (fs.existsSync(arrowPath)) return { filePath: arrowPath, format: 'arrow' };
        if (fs.existsSync(parquetPath)) return { filePath: parquetPath, format: 'parquet' };

        if (fs.existsSync(this.currentStoragePath)) {
            const files = fs.readdirSync(this.currentStoragePath);
            const lowerBase = baseName.toLowerCase();
            const foundDir = files.find(f => f.toLowerCase() === lowerBase && fs.existsSync(path.join(this.currentStoragePath, f, 'manifest.json')));
            if (foundDir) return { filePath: path.join(this.currentStoragePath, foundDir, 'manifest.json'), format: 'partitioned' };

            const foundArrow = files.find(f => f.toLowerCase() === `${lowerBase}.arrow`);
            if (foundArrow) return { filePath: path.join(this.currentStoragePath, foundArrow), format: 'arrow' };
            const foundParquet = files.find(f => f.toLowerCase() === `${lowerBase}.parquet`);
            if (foundParquet) return { filePath: path.join(this.currentStoragePath, foundParquet), format: 'parquet' };
        }
        return null;
    }

    private emitMapping(variableName: string, filePath: string, partitioned?: boolean) {
        const payload: any = { type: 'vura_io_mapping', variable: variableName, path: filePath };
        if (partitioned) {
            payload.partitioned = true;
        }
        process.stderr.write(JSON.stringify(payload) + '\n');
    }

    private async getDuckDbConn(): Promise<DuckDBConnection> {
        if (!this.duckDbConn) {
            this.duckDbInstance = await DuckDBInstance.create(':memory:');
            this.duckDbConn = await this.duckDbInstance.connect();
        }
        return this.duckDbConn;
    }

    private extractSchemaMap(records: any[]): Record<string, string> {
        const schemaMap: Record<string, string> = {};
        for (const r of records) {
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
        return schemaMap;
    }

    private checkTestPauseHook(): Promise<void> {
        if (process.env.VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE) {
            process.stderr.write("[VURA_TEST_HOOK] PAUSED_BEFORE_MANIFEST_WRITE\n");
            return new Promise(() => {}); // pause indefinitely until killed
        }
        return Promise.resolve();
    }

    private async saveManifestAtomically(tableName: string, manifest: any): Promise<string> {
        await this.checkTestPauseHook();
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const manifestPath = path.join(dirPath, 'manifest.json');
        const tmpPath = path.join(dirPath, `manifest.json.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`);
        await fs.promises.writeFile(tmpPath, JSON.stringify(manifest, null, 2));
        await fs.promises.rename(tmpPath, manifestPath);
        return manifestPath;
    }

    private async writeParquetPart(tableName: string, partName: string, records: any[]): Promise<string> {
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const partPath = path.join(dirPath, partName);
        const safeTarget = partPath.replace(/\\/g, '/');

        const schemaMap = this.extractSchemaMap(records);
        const conn = await this.getDuckDbConn();
        const tempTableName = `_temp_part_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const colDefs = Object.entries(schemaMap).map(([k, t]) => `"${k}" ${t}`).join(', ');
        await conn.runAndReadAll(`CREATE TEMP TABLE "${tempTableName}" (${colDefs})`);

        const appender = await conn.createAppender(tempTableName, 'main');
        const keys = Object.keys(schemaMap);

        for (const r of records) {
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

        await conn.runAndReadAll(`COPY "${tempTableName}" TO '${safeTarget}' (FORMAT PARQUET)`);
        await conn.runAndReadAll(`DROP TABLE IF EXISTS "${tempTableName}"`);

        return partPath;
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

        if (rawRecords.length < this.partitionThresholdRows) {
            const table = arrow.tableFromJSON(rawRecords);
            const buffer = arrow.tableToIPC(table, 'file');
            const arrowPath = this.getTablePath(tableName, 'arrow');
            await fs.promises.mkdir(path.dirname(arrowPath), { recursive: true });
            await fs.promises.writeFile(arrowPath, buffer);

            const parquetPath = this.getTablePath(tableName, 'parquet');
            if (fs.existsSync(parquetPath)) {
                await fs.promises.unlink(parquetPath).catch(() => {});
            }
            const partDir = path.join(this.currentStoragePath, tableName);
            if (fs.existsSync(partDir) && fs.statSync(partDir).isDirectory()) {
                await fs.promises.rm(partDir, { recursive: true, force: true }).catch(() => {});
            }

            return arrowPath;
        }

        const part0 = 'part-0000.parquet';
        await this.writeParquetPart(tableName, part0, rawRecords);
        const schemaMap = this.extractSchemaMap(rawRecords);
        const manifest = {
            version: 1,
            tableName,
            rowCount: rawRecords.length,
            compacted: false,
            parts: [{ file: part0, rowCount: rawRecords.length }],
            schema: schemaMap
        };
        const manifestPath = await this.saveManifestAtomically(tableName, manifest);

        const legacyArrow = this.getTablePath(tableName, 'arrow');
        if (fs.existsSync(legacyArrow)) {
            await fs.promises.unlink(legacyArrow).catch(() => {});
        }
        const legacyParquet = this.getTablePath(tableName, 'parquet');
        if (fs.existsSync(legacyParquet)) {
            await fs.promises.unlink(legacyParquet).catch(() => {});
        }

        return manifestPath;
    }

    private async readTableData(tableName: string): Promise<any[]> {
        const tableInfo = this.findExistingTablePath(tableName);
        if (!tableInfo) return [];

        if (tableInfo.format === 'partitioned') {
            const dirPath = path.dirname(tableInfo.filePath);
            const conn = await this.getDuckDbConn();
            const safeDirPath = dirPath.replace(/\\/g, '/');
            const reader = await conn.runAndReadAll(`SELECT * FROM read_parquet('${safeDirPath}/*.parquet', union_by_name=true)`);
            const colNames = reader.columnNames();
            const rows = reader.getRows();
            const numCols = colNames.length;
            const result = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const obj: Record<string, any> = {};
                for (let j = 0; j < numCols; j++) {
                    const val = row[j];
                    obj[colNames[j]] = val === null || val === undefined ? null : normalizeValue(val);
                }
                result[i] = obj;
            }
            return result;
        }

        if (tableInfo.format === 'arrow') {
            const buffer = await fs.promises.readFile(tableInfo.filePath);
            const table = arrow.tableFromIPC(buffer);
            const colNames = table.schema.fields.map(f => f.name);
            const rawRows = table.toArray();
            const result = new Array(rawRows.length);
            for (let i = 0; i < rawRows.length; i++) {
                const r = rawRows[i];
                const obj: Record<string, any> = {};
                for (const col of colNames) {
                    obj[col] = normalizeValue(r[col]);
                }
                result[i] = obj;
            }
            return result;
        }

        const conn = await this.getDuckDbConn();
        const safePath = tableInfo.filePath.replace(/\\/g, '/');
        let readQuery = `SELECT * FROM read_parquet('${safePath}')`;

        let reader = await conn.runAndReadAll(readQuery);

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
        this.bufferMap.delete(name);
        const { tables, manifest, tableNames } = shredJson(name, obj);
        this.manifests.set(name, manifest);

        for (const [tableName, records] of Object.entries(tables)) {
            this.bufferMap.delete(tableName);
            const writtenPath = await this.writeTableData(tableName, records);
            const isPart = writtenPath.endsWith('manifest.json');
            this.emitMapping(tableName, writtenPath, isPart);
            if (tableName.startsWith(`${name}_`)) {
                const shortKey = tableName.substring(name.length + 1);
                if (shortKey) {
                    this.emitMapping(shortKey, writtenPath, isPart);
                }
            }
        }

        const metaTableName = `__vura_meta_${name}`;
        const metaRecords = [{ manifest: JSON.stringify(manifest) }];
        await this.writeTableData(metaTableName, metaRecords);

        const rootTableInfo = this.findExistingTablePath(name);
        const rootPath = rootTableInfo ? rootTableInfo.filePath : this.getTablePath(name, 'parquet');
        this.emitMapping(name, rootPath, rootTableInfo?.format === 'partitioned');

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
        this.bufferMap.delete(name);
        if (obj && typeof obj === 'object' && (obj.constructor?.name === 'Table' || typeof obj.toArray === 'function')) {
            const writtenPath = await this.writeTableData(name, obj);
            this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
            return [name];
        }

        const isNested = (val: any): boolean => {
            if (!val || typeof val !== 'object') return false;
            if (ArrayBuffer.isView(val) || val instanceof Uint8Array || Buffer.isBuffer(val) || val?.constructor?.name === 'Buffer' || val?.constructor?.name === 'Uint8Array') return false;
            if (Array.isArray(val)) {
                return val.some(item => isNested(item));
            }
            return Object.values(val).some(v => isNested(v));
        };

        if (isNested(obj)) {
            return await this.pack(name, obj);
        }

        const records = Array.isArray(obj) ? obj : [obj];
        const writtenPath = await this.writeTableData(name, records);
        this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
        return [name];
    }

    public async get(name: string): Promise<any> {
        await this.flush(name);
        const metaTableName = `__vura_meta_${name}`;
        const metaInfo = this.findExistingTablePath(metaTableName);
        if (metaInfo || this.manifests.has(name)) {
            return await this.unpack(name);
        }
        return await this.readTableData(name);
    }

    public async count(name: string): Promise<number> {
        await this.flush(name);
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) return 0;

        if (tableInfo.format === 'partitioned') {
            try {
                const manifestContent = await fs.promises.readFile(tableInfo.filePath, 'utf-8');
                const manifest = JSON.parse(manifestContent);
                return manifest.rowCount || 0;
            } catch {
                return 0;
            }
        }

        if (tableInfo.format === 'arrow') {
            const buffer = await fs.promises.readFile(tableInfo.filePath);
            const table = arrow.tableFromIPC(buffer);
            return table.numRows;
        }

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
        await this.flush(name);
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo) return;

        const batchSize = options?.batchSize && options.batchSize > 0 ? options.batchSize : 50000;
        const total = await this.count(name);
        if (total === 0) return;

        const conn = await this.getDuckDbConn();

        if (tableInfo.format === 'arrow') {
            const buffer = await fs.promises.readFile(tableInfo.filePath);
            const table = arrow.tableFromIPC(buffer);
            const rawRows = table.toArray();
            const colNames = table.schema.fields.map(f => f.name);
            for (let offset = 0; offset < total; offset += batchSize) {
                const slice = rawRows.slice(offset, offset + batchSize);
                const chunk = slice.map(r => {
                    const obj: Record<string, any> = {};
                    for (const col of colNames) {
                        obj[col] = normalizeValue(r[col]);
                    }
                    return obj;
                });
                if (options?.format === 'arrow') {
                    yield arrow.tableFromJSON(chunk) as any;
                } else {
                    yield chunk;
                }
            }
            return;
        }

        const safePath = tableInfo.format === 'partitioned'
            ? path.dirname(tableInfo.filePath).replace(/\\/g, '/') + '/*.parquet'
            : tableInfo.filePath.replace(/\\/g, '/');

        const readFunc = tableInfo.format === 'partitioned'
            ? `read_parquet('${safePath}', union_by_name=true)`
            : `read_parquet('${safePath}')`;

        for (let offset = 0; offset < total; offset += batchSize) {
            const query = `SELECT * FROM ${readFunc} LIMIT ${batchSize} OFFSET ${offset}`;
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

            if (options?.format === 'arrow') {
                yield arrow.tableFromJSON(chunk) as any;
            } else {
                yield chunk;
            }
        }
    }

    public async append(name: string, obj: any): Promise<string[]> {
        const rawRecords = Array.isArray(obj) ? obj : [obj];
        if (rawRecords.length === 0) return [name];

        let buf = this.bufferMap.get(name) || [];
        buf.push(...rawRecords);
        this.bufferMap.set(name, buf);

        if (buf.length >= this.partitionThresholdRows) {
            await this.flush(name);
        }
        return [name];
    }

    public async flush(name: string): Promise<string[]> {
        const buffered = this.bufferMap.get(name);
        if (!buffered || buffered.length === 0) return [name];
        this.bufferMap.set(name, []);

        const tableInfo = this.findExistingTablePath(name);

        if (!tableInfo) {
            if (buffered.length < this.partitionThresholdRows) {
                const writtenPath = await this.writeTableData(name, buffered);
                this.emitMapping(name, writtenPath);
                return [name];
            } else {
                const part0 = 'part-0000.parquet';
                await this.writeParquetPart(name, part0, buffered);
                const schemaMap = this.extractSchemaMap(buffered);
                const manifest = {
                    version: 1,
                    tableName: name,
                    rowCount: buffered.length,
                    compacted: false,
                    parts: [{ file: part0, rowCount: buffered.length }],
                    schema: schemaMap
                };
                const manifestPath = await this.saveManifestAtomically(name, manifest);
                this.emitMapping(name, manifestPath, true);
                return [name];
            }
        }

        if (tableInfo.format === 'partitioned') {
            const manifestContent = await fs.promises.readFile(tableInfo.filePath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            const nextPartIndex = manifest.parts.length;
            const partName = `part-${String(nextPartIndex).padStart(4, '0')}.parquet`;
            await this.writeParquetPart(name, partName, buffered);

            manifest.parts.push({ file: partName, rowCount: buffered.length });
            manifest.rowCount += buffered.length;
            const schemaMap = this.extractSchemaMap(buffered);
            manifest.schema = { ...manifest.schema, ...schemaMap };

            const manifestPath = await this.saveManifestAtomically(name, manifest);
            this.emitMapping(name, manifestPath, true);
            return [name];
        }

        const existingRows = await this.readTableData(name);
        const totalRows = existingRows.length + buffered.length;

        if (totalRows < this.partitionThresholdRows) {
            const combined = existingRows.concat(buffered);
            const writtenPath = await this.writeTableData(name, combined);
            this.emitMapping(name, writtenPath);
            return [name];
        } else {
            const part0 = 'part-0000.parquet';
            const part1 = 'part-0001.parquet';
            await this.writeParquetPart(name, part0, existingRows);
            await this.writeParquetPart(name, part1, buffered);

            const schemaMap = this.extractSchemaMap(existingRows.concat(buffered));
            const manifest = {
                version: 1,
                tableName: name,
                rowCount: totalRows,
                compacted: false,
                parts: [
                    { file: part0, rowCount: existingRows.length },
                    { file: part1, rowCount: buffered.length }
                ],
                schema: schemaMap
            };
            const manifestPath = await this.saveManifestAtomically(name, manifest);

            if (fs.existsSync(tableInfo.filePath)) {
                await fs.promises.unlink(tableInfo.filePath).catch(() => {});
            }

            this.emitMapping(name, manifestPath, true);
            return [name];
        }
    }

    public async flushAll(): Promise<void> {
        for (const name of Array.from(this.bufferMap.keys())) {
            await this.flush(name);
        }
    }

    public async update(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        await this.flush(name);
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

        const existingRecords = await this.readTableData(name);
        const updatedRecords = existingRecords.map(targetRow => {
            const match = rawRecords.find(stageRow => keys.every(k => stageRow[k] === targetRow[k]));
            if (match) {
                return { ...targetRow, ...match };
            }
            return targetRow;
        });

        const writtenPath = await this.writeTableData(name, updatedRecords);
        this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
        return [name];
    }

    public async upsert(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        await this.flush(name);
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

        const existingRecords = await this.readTableData(name);
        const updatedRecords = [...existingRecords];

        for (const stageRow of rawRecords) {
            const idx = updatedRecords.findIndex(targetRow => keys.every(k => targetRow[k] === stageRow[k]));
            if (idx >= 0) {
                updatedRecords[idx] = { ...updatedRecords[idx], ...stageRow };
            } else {
                updatedRecords.push(stageRow);
            }
        }

        const writtenPath = await this.writeTableData(name, updatedRecords);
        this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
        return [name];
    }

    public async tables(name?: string): Promise<string[]> {
        await this.flushAll();
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
        const items = fs.readdirSync(this.currentStoragePath);
        const res: string[] = [];
        for (const item of items) {
            if (item.startsWith('__vura_meta_')) continue;
            const fullPath = path.join(this.currentStoragePath, item);
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'manifest.json'))) {
                res.push(item);
            } else if (item.endsWith('.parquet') || item.endsWith('.arrow')) {
                res.push(item.replace(/\.(parquet|arrow)$/, ''));
            }
        }
        return res;
    }
}

export const data = new DataManager();
