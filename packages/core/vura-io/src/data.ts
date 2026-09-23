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

export function formatTimestampForDuckDb(val: any): string | null {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) {
        return isNaN(val.getTime()) ? null : val.toISOString();
    }
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) return null;
        let ms = val;
        const abs = Math.abs(val);
        if (abs >= 1e17) {
            ms = Math.trunc(val / 1e6);
        } else if (abs >= 1e14) {
            ms = Math.trunc(val / 1e3);
        } else if (abs >= 1e7 && abs < 1e11) {
            ms = val * 1000;
        }
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof val === 'bigint') {
        let ms = val;
        const abs = val < 0n ? -val : val;
        if (abs >= 100000000000000000n) {
            ms = val / 1000000n;
        } else if (abs >= 100000000000000n) {
            ms = val / 1000n;
        } else if (abs >= 10000000n && abs < 100000000000n) {
            ms = val * 1000n;
        }
        const d = new Date(Number(ms));
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return null;
        if (/^-?\d+$/.test(trimmed)) {
            try {
                if (trimmed.length > 15) {
                    return formatTimestampForDuckDb(BigInt(trimmed));
                }
                return formatTimestampForDuckDb(Number(trimmed));
            } catch {
                return null;
            }
        }
        const parsed = new Date(trimmed);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        return trimmed;
    }
    if (typeof val === 'object' && typeof (val as any).toISOString === 'function') {
        try {
            return (val as any).toISOString();
        } catch {
            return null;
        }
    }
    const fallback = new Date(val);
    return isNaN(fallback.getTime()) ? null : fallback.toISOString();
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
    public pendingCalls: Set<Promise<any>> = new Set();

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

    private checkTestPauseHook(hookName: 'VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND' | 'VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE'): Promise<void> {
        if (process.env[hookName]) {
            const sentinel = hookName === 'VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND'
                ? 'PAUSED_BEFORE_PARTS_LOG_APPEND'
                : 'PAUSED_BEFORE_MANIFEST_WRITE';
            process.stderr.write(`[VURA_TEST_HOOK] ${sentinel}\n`);
            return new Promise(() => {}); // pause indefinitely until killed
        }
        return Promise.resolve();
    }

    private async getManifestParts(dirPath: string): Promise<{ file: string; rowCount: number }[]> {
        const partsPath = path.join(dirPath, 'manifest-parts.jsonl');
        if (!fs.existsSync(partsPath)) return [];
        const content = await fs.promises.readFile(partsPath, 'utf-utf-8' in Buffer ? 'utf-8' : 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        return lines.map(line => JSON.parse(line));
    }

    private async appendManifestPart(tableName: string, partEntry: { file: string; rowCount: number }): Promise<void> {
        await this.checkTestPauseHook('VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND');
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const partsPath = path.join(dirPath, 'manifest-parts.jsonl');
        await fs.promises.appendFile(partsPath, JSON.stringify(partEntry) + '\n');
    }

    private async saveManifestPartsAtomically(tableName: string, parts: { file: string; rowCount: number }[]): Promise<string> {
        await this.checkTestPauseHook('VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND');
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const partsPath = path.join(dirPath, 'manifest-parts.jsonl');
        const tmpPath = path.join(dirPath, `manifest-parts.jsonl.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`);
        const content = parts.map(p => JSON.stringify(p)).join('\n') + (parts.length > 0 ? '\n' : '');
        await fs.promises.writeFile(tmpPath, content);
        await fs.promises.rename(tmpPath, partsPath);
        return partsPath;
    }

    private async saveManifestAtomically(tableName: string, manifest: any): Promise<string> {
        await this.checkTestPauseHook('VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE');
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
                } else if (type === 'TIMESTAMP') {
                    const formatted = formatTimestampForDuckDb(val);
                    if (formatted === null) {
                        appender.appendNull();
                    } else {
                        try {
                            appender.appendVarchar(formatted);
                        } catch {
                            appender.appendNull();
                        }
                    }
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
        await this.saveManifestPartsAtomically(tableName, [{ file: part0, rowCount: rawRecords.length }]);

        const schemaMap = this.extractSchemaMap(rawRecords);
        const manifest = {
            version: 1,
            tableName,
            rowCount: rawRecords.length,
            compacted: false,
            nextPartIndex: 1,
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
            const parts = await this.getManifestParts(dirPath);
            if (parts.length === 0) return [];

            const conn = await this.getDuckDbConn();
            const safePartPaths = parts.map(p => path.join(dirPath, p.file).replace(/\\/g, '/'));
            const filesArg = safePartPaths.map(p => `'${p}'`).join(', ');
            const reader = await conn.runAndReadAll(`SELECT * FROM read_parquet([${filesArg}], union_by_name=true)`);
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

        private trackAsync<T>(promise: Promise<T>): Promise<T> {
        this.pendingCalls.add(promise);
        promise.catch(() => {}).finally(() => {
            this.pendingCalls.delete(promise);
        });
        return promise;
    }

    public async pack(name: string, obj: any): Promise<string[]> {
        const _p = (async () => {
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
    })();
        return this.trackAsync(_p);
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
        const _p = (async () => {
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
    })();
        return this.trackAsync(_p);
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
            if (options?.format === 'arrow') {
                for (let offset = 0; offset < total; offset += batchSize) {
                    yield table.slice(offset, Math.min(offset + batchSize, total)) as any;
                }
                return;
            }
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
                yield chunk;
            }
            return;
        }

        let readFunc: string;
        if (tableInfo.format === 'partitioned') {
            const dirPath = path.dirname(tableInfo.filePath);
            const parts = await this.getManifestParts(dirPath);
            if (parts.length === 0) return;
            const safePartPaths = parts.map(p => path.join(dirPath, p.file).replace(/\\/g, '/'));
            const filesArg = safePartPaths.map(p => `'${p}'`).join(', ');
            readFunc = `read_parquet([${filesArg}], union_by_name=true)`;
        } else {
            const safePath = tableInfo.filePath.replace(/\\/g, '/');
            readFunc = `read_parquet('${safePath}')`;
        }

        for (let offset = 0; offset < total; offset += batchSize) {
            const query = `SELECT * FROM ${readFunc} LIMIT ${batchSize} OFFSET ${offset}`;
            const reader = await conn.runAndReadAll(query);

            if (options?.format === 'arrow') {
                const colsObj = reader.getColumnsObject();
                const vecs: Record<string, any> = {};
                for (const [k, v] of Object.entries(colsObj)) {
                    vecs[k] = arrow.vectorFromArray(v as any);
                }
                yield new arrow.Table(vecs) as any;
            } else {
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
    }

    public async append(name: string, obj: any): Promise<string[]> {
        const _p = (async () => {
        const rawRecords = Array.isArray(obj) ? obj : [obj];
        if (rawRecords.length === 0) return [name];

        let buf = this.bufferMap.get(name) || [];
        buf.push(...rawRecords);
        this.bufferMap.set(name, buf);

        if (buf.length >= this.partitionThresholdRows) {
            await this.flush(name);
        }
        return [name];
    })();
        return this.trackAsync(_p);
    }

    public async flush(name: string): Promise<string[]> {
        const _p = (async () => {
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
                await this.saveManifestPartsAtomically(name, [{ file: part0, rowCount: buffered.length }]);

                const schemaMap = this.extractSchemaMap(buffered);
                const manifest = {
                    version: 1,
                    tableName: name,
                    rowCount: buffered.length,
                    compacted: false,
                    nextPartIndex: 1,
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
            const nextPartIndex = manifest.nextPartIndex ?? 0;
            const partName = `part-${String(nextPartIndex).padStart(4, '0')}.parquet`;
            await this.writeParquetPart(name, partName, buffered);
            await this.appendManifestPart(name, { file: partName, rowCount: buffered.length });

            manifest.rowCount += buffered.length;
            manifest.nextPartIndex = nextPartIndex + 1;
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

            await this.saveManifestPartsAtomically(name, [
                { file: part0, rowCount: existingRows.length },
                { file: part1, rowCount: buffered.length }
            ]);

            const schemaMap = this.extractSchemaMap(existingRows.concat(buffered));
            const manifest = {
                version: 1,
                tableName: name,
                rowCount: totalRows,
                compacted: false,
                nextPartIndex: 2,
                schema: schemaMap
            };
            const manifestPath = await this.saveManifestAtomically(name, manifest);

            if (fs.existsSync(tableInfo.filePath)) {
                await fs.promises.unlink(tableInfo.filePath).catch(() => {});
            }

            this.emitMapping(name, manifestPath, true);
            return [name];
        }
    })();
        return this.trackAsync(_p);
    }

    public async flushAll(): Promise<void> {
        for (const name of Array.from(this.bufferMap.keys())) {
            await this.flush(name);
        }
        while (this.pendingCalls.size > 0) {
            const currentCalls = Array.from(this.pendingCalls);
            const results = await Promise.allSettled(currentCalls);
            for (const res of results) {
                if (res.status === 'rejected') {
                    throw res.reason;
                }
            }
        }
    }

    public async update(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        const _p = (async () => {
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
    })();
        return this.trackAsync(_p);
    }

    public async upsert(name: string, records: any, options: UpdateOptions): Promise<string[]> {
        const _p = (async () => {
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
    })();
        return this.trackAsync(_p);
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
