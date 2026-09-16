const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { DuckDBInstance } = require('@duckdb/node-api');
const arrow = require('apache-arrow');
const crypto = require("crypto");
function shredJson(datasetName, obj) {
    const tables = {};
    const manifest = {
        dataset_name: datasetName,
        root_table: datasetName,
        is_root_array: Array.isArray(obj),
        tables: {}
    };
    function uuid() {
        return crypto.randomUUID();
    }
    function processNode(node, tableName, parentTable, fieldName, parentId, indexInParent) {
        if (!manifest.tables[tableName]) {
            manifest.tables[tableName] = {
                table_name: tableName,
                parent_table: parentTable,
                field_name: fieldName,
                node_type: Array.isArray(node) ? 'array' : 'object',
                field_order: [],
                field_types: {},
                children: {}
            };
        }
        const meta = manifest.tables[tableName];
        if (!tables[tableName]) {
            tables[tableName] = [];
        }
        if (Array.isArray(node)) {
            if (node.length === 0) {
                if (!meta.node_type)
                    meta.node_type = 'array';
                return;
            }
            const isPrimitiveArray = node.some(item => item === null || typeof item !== 'object');
            if (isPrimitiveArray) {
                meta.node_type = 'primitive_array';
                for (let i = 0; i < node.length; i++) {
                    const rowId = uuid();
                    tables[tableName].push({
                        _vura_id: rowId,
                        _vura_parent_id: parentId,
                        _vura_index: i,
                        _vura_value: node[i]
                    });
                }
                return;
            }
            if (meta.node_type !== 'primitive_array') {
                meta.node_type = 'array';
            }
            for (let i = 0; i < node.length; i++) {
                processObjectItem(node[i], tableName, parentId, i);
            }
        }
        else if (node && typeof node === 'object') {
            meta.node_type = 'object';
            processObjectItem(node, tableName, parentId, indexInParent);
        }
    }
    function processObjectItem(item, tableName, parentId, index) {
        const meta = manifest.tables[tableName];
        const rowId = uuid();
        const row = {
            _vura_id: rowId,
            _vura_parent_id: parentId,
            _vura_index: index
        };
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const [key, value] of Object.entries(item)) {
                if (!meta.field_order.includes(key)) {
                    meta.field_order.push(key);
                }
                if (value === null || value === undefined) {
                    meta.field_types[key] = 'null';
                    row[key] = null;
                }
                else if (typeof value === 'object') {
                    const childTableName = `${tableName}_${key}`;
                    meta.field_types[key] = Array.isArray(value) ? 'array' : 'object';
                    meta.children[key] = childTableName;
                    processNode(value, childTableName, tableName, key, rowId, 0);
                }
                else {
                    meta.field_types[key] = typeof value;
                    row[key] = value;
                }
            }
        }
        tables[tableName].push(row);
    }
    processNode(obj, datasetName, null, null, null, 0);
    const tableNames = Object.keys(manifest.tables);
    return { tables, manifest, tableNames };
}
function unshredJson(manifest, tables) {
    const rowIndexes = new Map();
    for (const [tName, rows] of Object.entries(tables)) {
        const byParent = new Map();
        for (const r of (rows || [])) {
            const pId = (!r._vura_parent_id || r._vura_parent_id === 'null') ? null : String(r._vura_parent_id);
            if (!byParent.has(pId))
                byParent.set(pId, []);
            byParent.get(pId).push(r);
        }
        rowIndexes.set(tName, byParent);
    }
    function reconstructNode(tableName, parentId) {
        const meta = manifest.tables[tableName];
        if (!meta)
            return null;
        const pKey = parentId === null ? null : String(parentId);
        const tableRows = rowIndexes.get(tableName)?.get(pKey) || [];
        tableRows.sort((a, b) => (a._vura_index ?? 0) - (b._vura_index ?? 0));
        if (meta.node_type === 'primitive_array') {
            return tableRows.map(r => r._vura_value);
        }
        if (meta.node_type === 'array') {
            return tableRows.map(r => reconstructItem(r, meta));
        }
        if (tableRows.length === 0) {
            return null;
        }
        return reconstructItem(tableRows[0], meta);
    }
    function reconstructItem(row, meta) {
        const item = {};
        for (const key of meta.field_order) {
            if (meta.children[key]) {
                const childTableName = meta.children[key];
                const childMeta = manifest.tables[childTableName];
                const childVal = reconstructNode(childTableName, row._vura_id);
                if (childVal === null && childMeta?.node_type === 'array') {
                    item[key] = [];
                }
                else {
                    item[key] = childVal;
                }
            }
            else if (key in row) {
                item[key] = row[key];
            }
            else {
                item[key] = null;
            }
        }
        return item;
    }
    return reconstructNode(manifest.root_table, null);
}

function normalizeValue(val) {
    if (val === null || val === undefined)
        return null;
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
    if (val instanceof Date)
        return val.toISOString();
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
            const res = {};
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
        const res = {};
        for (const [k, v] of Object.entries(val)) {
            res[k] = normalizeValue(v);
        }
        return res;
    }
    return val;
}
class DataManager {
    storagePath;
    manifests = new Map();
    duckDbInstance;
    duckDbConn;
    bufferMap = new Map();
    pendingCalls = new Set();
    constructor(storagePath) {
        this.storagePath = storagePath || process.env.VURA_STORAGE_PATH || process.cwd();
    }
    setStoragePath(p) {
        this.storagePath = p;
    }
    get currentStoragePath() {
        return process.env.VURA_STORAGE_PATH || this.storagePath;
    }
    get partitionThresholdRows() {
        const envVal = process.env.VURA_PARTITION_THRESHOLD_ROWS;
        if (envVal) {
            const parsed = parseInt(envVal, 10);
            if (!isNaN(parsed) && parsed >= 0)
                return parsed;
        }
        return 50000;
    }
    getTablePath(tableName, ext) {
        return path.join(this.currentStoragePath, `${tableName}.${ext}`);
    }
    findExistingTablePath(tableName) {
        let baseName = tableName.replace(/\.(arrow|parquet)$/, '');
        let manifestPath = path.join(this.currentStoragePath, baseName, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            return { filePath: manifestPath, format: 'partitioned' };
        }
        let arrowPath = this.getTablePath(baseName, 'arrow');
        let parquetPath = this.getTablePath(baseName, 'parquet');
        if (fs.existsSync(arrowPath))
            return { filePath: arrowPath, format: 'arrow' };
        if (fs.existsSync(parquetPath))
            return { filePath: parquetPath, format: 'parquet' };
        if (fs.existsSync(this.currentStoragePath)) {
            const files = fs.readdirSync(this.currentStoragePath);
            const lowerBase = baseName.toLowerCase();
            const foundDir = files.find(f => f.toLowerCase() === lowerBase && fs.existsSync(path.join(this.currentStoragePath, f, 'manifest.json')));
            if (foundDir)
                return { filePath: path.join(this.currentStoragePath, foundDir, 'manifest.json'), format: 'partitioned' };
            const foundArrow = files.find(f => f.toLowerCase() === `${lowerBase}.arrow`);
            if (foundArrow)
                return { filePath: path.join(this.currentStoragePath, foundArrow), format: 'arrow' };
            const foundParquet = files.find(f => f.toLowerCase() === `${lowerBase}.parquet`);
            if (foundParquet)
                return { filePath: path.join(this.currentStoragePath, foundParquet), format: 'parquet' };
        }
        return null;
    }
    emitMapping(variableName, filePath, partitioned) {
        const payload = { type: 'vura_io_mapping', variable: variableName, path: filePath };
        if (partitioned) {
            payload.partitioned = true;
        }
        process.stderr.write(JSON.stringify(payload) + '\n');
    }
    async getDuckDbConn() {
        if (!this.duckDbConn) {
            this.duckDbInstance = await DuckDBInstance.create(':memory:');
            this.duckDbConn = await this.duckDbInstance.connect();
        }
        return this.duckDbConn;
    }
    extractSchemaMap(records) {
        const schemaMap = {};
        for (const r of records) {
            if (r && typeof r === 'object') {
                for (const [k, v] of Object.entries(r)) {
                    if (!schemaMap[k] || schemaMap[k] === 'VARCHAR') {
                        if (v === null || v === undefined) {
                            if (!schemaMap[k])
                                schemaMap[k] = 'VARCHAR';
                        }
                        else if (typeof v === 'boolean') {
                            schemaMap[k] = 'BOOLEAN';
                        }
                        else if (typeof v === 'number') {
                            schemaMap[k] = Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
                        }
                        else if (typeof v === 'bigint') {
                            schemaMap[k] = 'BIGINT';
                        }
                        else if (v instanceof Date) {
                            schemaMap[k] = 'TIMESTAMP';
                        }
                        else {
                            schemaMap[k] = 'VARCHAR';
                        }
                    }
                    else if (schemaMap[k] === 'BIGINT' && typeof v === 'number' && !Number.isInteger(v)) {
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
    checkTestPauseHook(hookName) {
        if (process.env[hookName]) {
            const sentinel = hookName === 'VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND'
                ? 'PAUSED_BEFORE_PARTS_LOG_APPEND'
                : 'PAUSED_BEFORE_MANIFEST_WRITE';
            process.stderr.write(`[VURA_TEST_HOOK] ${sentinel}\n`);
            return new Promise(() => { }); // pause indefinitely until killed
        }
        return Promise.resolve();
    }
    async getManifestParts(dirPath) {
        const partsPath = path.join(dirPath, 'manifest-parts.jsonl');
        if (!fs.existsSync(partsPath))
            return [];
        const content = await fs.promises.readFile(partsPath, 'utf-utf-8' in Buffer ? 'utf-8' : 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        return lines.map(line => JSON.parse(line));
    }
    async appendManifestPart(tableName, partEntry) {
        await this.checkTestPauseHook('VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND');
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const partsPath = path.join(dirPath, 'manifest-parts.jsonl');
        await fs.promises.appendFile(partsPath, JSON.stringify(partEntry) + '\n');
    }
    async saveManifestPartsAtomically(tableName, parts) {
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
    async saveManifestAtomically(tableName, manifest) {
        await this.checkTestPauseHook('VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE');
        const dirPath = path.join(this.currentStoragePath, tableName);
        await fs.promises.mkdir(dirPath, { recursive: true });
        const manifestPath = path.join(dirPath, 'manifest.json');
        const tmpPath = path.join(dirPath, `manifest.json.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`);
        await fs.promises.writeFile(tmpPath, JSON.stringify(manifest, null, 2));
        await fs.promises.rename(tmpPath, manifestPath);
        return manifestPath;
    }
    async writeParquetPart(tableName, partName, records) {
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
                }
                else if (type === 'BIGINT') {
                    if (typeof val === 'number' && !Number.isInteger(val)) {
                        appender.appendDouble(val);
                    }
                    else {
                        appender.appendBigInt(BigInt(Math.trunc(Number(val))));
                    }
                }
                else if (type === 'DOUBLE') {
                    appender.appendDouble(Number(val));
                }
                else if (type === 'BOOLEAN') {
                    appender.appendBoolean(Boolean(val));
                }
                else if (type === 'TIMESTAMP' && val instanceof Date) {
                    appender.appendVarchar(val.toISOString());
                }
                else {
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
    async writeTableData(tableName, records) {
        let rawRecords;
        if (records && typeof records === 'object' && (records.constructor?.name === 'Table' || typeof records.toArray === 'function')) {
            rawRecords = records.toArray();
        }
        else {
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
                await fs.promises.unlink(parquetPath).catch(() => { });
            }
            const partDir = path.join(this.currentStoragePath, tableName);
            if (fs.existsSync(partDir) && fs.statSync(partDir).isDirectory()) {
                await fs.promises.rm(partDir, { recursive: true, force: true }).catch(() => { });
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
            await fs.promises.unlink(legacyArrow).catch(() => { });
        }
        const legacyParquet = this.getTablePath(tableName, 'parquet');
        if (fs.existsSync(legacyParquet)) {
            await fs.promises.unlink(legacyParquet).catch(() => { });
        }
        return manifestPath;
    }
    async readTableData(tableName) {
        const tableInfo = this.findExistingTablePath(tableName);
        if (!tableInfo)
            return [];
        if (tableInfo.format === 'partitioned') {
            const dirPath = path.dirname(tableInfo.filePath);
            const parts = await this.getManifestParts(dirPath);
            if (parts.length === 0)
                return [];
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
                const obj = {};
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
                const obj = {};
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
            const obj = {};
            for (let j = 0; j < numCols; j++) {
                const val = row[j];
                if (val === null || val === undefined) {
                    obj[colNames[j]] = null;
                }
                else {
                    obj[colNames[j]] = normalizeValue(val);
                }
            }
            result[i] = obj;
        }
        return result;
    }
    trackAsync(promise) {
        this.pendingCalls.add(promise);
        promise.catch(() => { }).finally(() => {
            this.pendingCalls.delete(promise);
        });
        return promise;
    }
    async pack(name, obj) {
        const _p = (async () => {
            this.bufferMap.delete(name);
            const { tables, manifest, tableNames } = (0, shredJson)(name, obj);
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
    async unpack(name) {
        let manifest = this.manifests.get(name);
        if (!manifest) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableData(metaTableName);
            if (!metaRecords || metaRecords.length === 0 || !metaRecords[0].manifest) {
                throw new Error(`Dataset metadata for '${name}' not found.`);
            }
            manifest = JSON.parse(metaRecords[0].manifest);
            this.manifests.set(name, manifest);
        }
        const tables = {};
        for (const tableName of Object.keys(manifest.tables)) {
            tables[tableName] = await this.readTableData(tableName);
        }
        return (0, unshredJson)(manifest, tables);
    }
    async put(name, obj) {
        const _p = (async () => {
            this.bufferMap.delete(name);
            if (obj && typeof obj === 'object' && (obj.constructor?.name === 'Table' || typeof obj.toArray === 'function')) {
                const writtenPath = await this.writeTableData(name, obj);
                this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
                return [name];
            }
            const isNested = (val) => {
                if (!val || typeof val !== 'object')
                    return false;
                if (ArrayBuffer.isView(val) || val instanceof Uint8Array || Buffer.isBuffer(val) || val?.constructor?.name === 'Buffer' || val?.constructor?.name === 'Uint8Array')
                    return false;
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
    async get(name) {
        await this.flush(name);
        const metaTableName = `__vura_meta_${name}`;
        const metaInfo = this.findExistingTablePath(metaTableName);
        if (metaInfo || this.manifests.has(name)) {
            return await this.unpack(name);
        }
        return await this.readTableData(name);
    }
    async count(name) {
        await this.flush(name);
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo)
            return 0;
        if (tableInfo.format === 'partitioned') {
            try {
                const manifestContent = await fs.promises.readFile(tableInfo.filePath, 'utf-8');
                const manifest = JSON.parse(manifestContent);
                return manifest.rowCount || 0;
            }
            catch {
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
    async *stream(name, options) {
        await this.flush(name);
        const tableInfo = this.findExistingTablePath(name);
        if (!tableInfo)
            return;
        const batchSize = options?.batchSize && options.batchSize > 0 ? options.batchSize : 50000;
        const total = await this.count(name);
        if (total === 0)
            return;
        const conn = await this.getDuckDbConn();
        if (tableInfo.format === 'arrow') {
            const buffer = await fs.promises.readFile(tableInfo.filePath);
            const table = arrow.tableFromIPC(buffer);
            if (options?.format === 'arrow') {
                for (let offset = 0; offset < total; offset += batchSize) {
                    yield table.slice(offset, Math.min(offset + batchSize, total));
                }
                return;
            }
            const rawRows = table.toArray();
            const colNames = table.schema.fields.map(f => f.name);
            for (let offset = 0; offset < total; offset += batchSize) {
                const slice = rawRows.slice(offset, offset + batchSize);
                const chunk = slice.map(r => {
                    const obj = {};
                    for (const col of colNames) {
                        obj[col] = normalizeValue(r[col]);
                    }
                    return obj;
                });
                yield chunk;
            }
            return;
        }
        let readFunc;
        if (tableInfo.format === 'partitioned') {
            const dirPath = path.dirname(tableInfo.filePath);
            const parts = await this.getManifestParts(dirPath);
            if (parts.length === 0)
                return;
            const safePartPaths = parts.map(p => path.join(dirPath, p.file).replace(/\\/g, '/'));
            const filesArg = safePartPaths.map(p => `'${p}'`).join(', ');
            readFunc = `read_parquet([${filesArg}], union_by_name=true)`;
        }
        else {
            const safePath = tableInfo.filePath.replace(/\\/g, '/');
            readFunc = `read_parquet('${safePath}')`;
        }
        for (let offset = 0; offset < total; offset += batchSize) {
            const query = `SELECT * FROM ${readFunc} LIMIT ${batchSize} OFFSET ${offset}`;
            const reader = await conn.runAndReadAll(query);
            if (options?.format === 'arrow') {
                const colsObj = reader.getColumnsObject();
                const vecs = {};
                for (const [k, v] of Object.entries(colsObj)) {
                    vecs[k] = arrow.vectorFromArray(v);
                }
                yield new arrow.Table(vecs);
            }
            else {
                const colNames = reader.columnNames();
                const rows = reader.getRows();
                const numCols = colNames.length;
                const chunk = new Array(rows.length);
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const obj = {};
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
    async append(name, obj) {
        const _p = (async () => {
            const rawRecords = Array.isArray(obj) ? obj : [obj];
            if (rawRecords.length === 0)
                return [name];
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
    async flush(name) {
        const _p = (async () => {
            const buffered = this.bufferMap.get(name);
            if (!buffered || buffered.length === 0)
                return [name];
            this.bufferMap.set(name, []);
            const tableInfo = this.findExistingTablePath(name);
            if (!tableInfo) {
                if (buffered.length < this.partitionThresholdRows) {
                    const writtenPath = await this.writeTableData(name, buffered);
                    this.emitMapping(name, writtenPath);
                    return [name];
                }
                else {
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
            }
            else {
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
                    await fs.promises.unlink(tableInfo.filePath).catch(() => { });
                }
                this.emitMapping(name, manifestPath, true);
                return [name];
            }
        })();
        return this.trackAsync(_p);
    }
    async flushAll() {
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
    async update(name, records, options) {
        const _p = (async () => {
            await this.flush(name);
            const tableInfo = this.findExistingTablePath(name);
            if (!tableInfo) {
                throw new Error(`Table '${name}' does not exist to update.`);
            }
            const rawRecords = Array.isArray(records) ? records : [records];
            if (rawRecords.length === 0)
                return [name];
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
    async upsert(name, records, options) {
        const _p = (async () => {
            await this.flush(name);
            const tableInfo = this.findExistingTablePath(name);
            if (!tableInfo) {
                return await this.put(name, records);
            }
            const rawRecords = Array.isArray(records) ? records : [records];
            if (rawRecords.length === 0)
                return [name];
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
                }
                else {
                    updatedRecords.push(stageRow);
                }
            }
            const writtenPath = await this.writeTableData(name, updatedRecords);
            this.emitMapping(name, writtenPath, writtenPath.endsWith('manifest.json'));
            return [name];
        })();
        return this.trackAsync(_p);
    }
    async tables(name) {
        await this.flushAll();
        if (name) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableData(metaTableName);
            if (metaRecords && metaRecords.length > 0 && metaRecords[0].manifest) {
                const manifest = JSON.parse(metaRecords[0].manifest);
                return Object.keys(manifest.tables);
            }
            return [name];
        }
        if (!fs.existsSync(this.currentStoragePath))
            return [];
        const items = fs.readdirSync(this.currentStoragePath);
        const res = [];
        for (const item of items) {
            if (item.startsWith('__vura_meta_'))
                continue;
            const fullPath = path.join(this.currentStoragePath, item);
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'manifest.json'))) {
                res.push(item);
            }
            else if (item.endsWith('.parquet') || item.endsWith('.arrow')) {
                res.push(item.replace(/\.(parquet|arrow)$/, ''));
            }
        }
        return res;
    }
}

class MetricsManager {
    track(name, value, step) {
        const payload = { type: 'vura_metric', name, value, step: step ?? null, timestamp: Date.now() };
        process.stderr.write(JSON.stringify(payload) + '\n');
    }
    log(message, level = 'INFO') {
        const payload = { type: 'vura_log', level: level.toUpperCase(), message, timestamp: Date.now() };
        console.log(`[${level.toUpperCase()}] ${message}`);
    }
    preview(name, sample) {
        const payload = { type: 'vura_preview', name, sample, timestamp: Date.now() };
        process.stderr.write(JSON.stringify(payload) + '\n');
    }
}

class StateManager {
    store = new Map();
    currentCtx = {};
    set(key, value) {
        this.store.set(key, value);
    }
    get(key, defaultValue = null) {
        if (this.store.has(key)) {
            return this.store.get(key);
        }
        return defaultValue;
    }
    // Per-request context (e.g. { token, depthLimit }) injected by the
    // sidecar for each incoming request — kept off process.env so a
    // secret like a Dataverse token never leaks into child processes or
    // logs (see sidecarProtocolFixes.test.ts, 2b).
    setRequestCtx(ctx) {
        this.currentCtx = ctx || {};
    }
    get context() {
        const depthLimit = this.currentCtx.depthLimit ?? parseInt(process.env.VURA_DEPTH_LIMIT || '5', 10);
        return {
            storagePath: process.env.VURA_STORAGE_PATH || '',
            notebookId: process.env.VURA_NOTEBOOK_ID || 'default',
            depthLimit,
            token: this.currentCtx.token || '',
            env: process.env
        };
    }
}


function transformImports(code) {
    if (typeof code !== 'string') return code;
    return code
        .replace(/^(\s*)import\s+(\*\s+as\s+\w+)\s+from\s+(['"][^'"]+['"])\s*;?/gm, '$1const $2 = require($3);')
        .replace(/^(\s*)import\s+([\w$]+)\s*,\s*(\{[\s\S]*?\})\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, defaultImport, namedImports, mod) => {
            const destructured = namedImports.slice(1, -1).split(',').map((s) => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
            }).filter(Boolean).join(', ');
            return `${indent}const _default_${defaultImport} = require(${mod}); const ${defaultImport} = _default_${defaultImport}.default || _default_${defaultImport}; const { ${destructured} } = require(${mod});`;
        })
        .replace(/^(\s*)import\s+(\{[\s\S]*?\})\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, clause, mod) => {
            const destructured = clause.slice(1, -1).split(',').map((s) => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
            }).filter(Boolean).join(', ');
            return `${indent}const { ${destructured} } = require(${mod});`;
        })
        .replace(/^(\s*)import\s+([\w$]+)\s+from\s+(['"][^'"]+['"])\s*;?/gm, (match, indent, defaultImport, mod) => {
            return `${indent}const _default_${defaultImport} = require(${mod}); const ${defaultImport} = _default_${defaultImport}.default || _default_${defaultImport};`;
        })
        .replace(/^(\s*)import\s+(['"][^'"]+['"])\s*;?/gm, '$1require($2);');
}

function serveForever(data, state, metrics) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let isExecuting = false;
    const realStdoutWrite = process.stdout.write.bind(process.stdout);

    // Cell code often follows the documented fire-and-forget pattern
    // (`async function run() { ... } run();` with no top-level await —
    // see docs/DEVELOPMENT_PLAYBOOK.md), so the outer `(async () => {...})()`
    // wrapper below can resolve before run()'s own work — e.g. a
    // data.put(...) — has finished. Wrapping data's async methods lets each
    // request track any such in-flight calls and drain them before
    // responding, so their writes (and vura_io_mapping emissions) land
    // before the sidecar replies.
    let pendingOps = [];
    for (const name of ['put', 'get', 'append', 'count', 'flush', 'flushAll', 'stream', 'pack', 'unpack', 'tables']) {
        if (typeof data[name] !== 'function') continue;
        const orig = data[name].bind(data);
        data[name] = (...args) => {
            const result = orig(...args);
            pendingOps.push(Promise.resolve(result).catch(() => {}));
            return result;
        };
    }

    return new Promise((resolve) => {
        rl.on('line', async (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            let request;
            try { request = JSON.parse(trimmed); } catch { return; }

            const { id, code, filename, ctx: reqCtx } = request;

            if (isExecuting) {
                const errResp = {
                    id,
                    status: 'error',
                    stdout: '',
                    stderr: '',
                    error: 'Sidecar process is busy with another request'
                };
                realStdoutWrite(JSON.stringify(errResp) + '\n');
                return;
            }

            isExecuting = true;
            pendingOps = [];
            try {
                const ctx = reqCtx || {};
                if (typeof state.setRequestCtx === 'function') {
                    state.setRequestCtx(ctx);
                }
                if (ctx.storagePath) {
                    data.storagePath = ctx.storagePath;
                    process.env.VURA_STORAGE_PATH = ctx.storagePath;
                }

                let stdoutBuf = '';
                let stderrBuf = '';
                const origStdoutWrite = process.stdout.write.bind(process.stdout);
                const origStderrWrite = process.stderr.write.bind(process.stderr);

                process.stdout.write = (chunk) => { stdoutBuf += chunk.toString(); return true; };
                process.stderr.write = (chunk) => {
                    const str = chunk.toString();
                    if (str.includes('[VURA_TEST_HOOK]')) {
                        origStderrWrite(chunk);
                    }
                    stderrBuf += str;
                    return true;
                };

                let status = 'ok';
                let errorMessage;
                const cellFilename = filename || path.join(process.cwd(), 'cell.js');

                try {
                    let processedCode = transformImports(code);
                    const wrapped = `(async () => {\n${processedCode}\n})()`;
                    const script = new vm.Script(wrapped, { filename: cellFilename });
                    const vuraObj = {
                        io: { data, state, metrics },
                        data, state, metrics,
                        put: data.put.bind(data),
                        get: data.get.bind(data),
                        save_table: data.put.bind(data),
                        saveTable: data.put.bind(data),
                        get_table: data.get.bind(data),
                        getTable: data.get.bind(data),
                        append: data.append.bind(data),
                        count: data.count.bind(data),
                        flush: data.flush.bind(data),
                        stream: data.stream.bind(data)
                    };
                    const sandbox = {
                        require, module, exports,
                        __dirname: path.dirname(cellFilename),
                        __filename: cellFilename,
                        console, process, Buffer,
                        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
                        URL, URLSearchParams, TextEncoder, TextDecoder,
                        data, state, metrics,
                        ctx,
                        vura: vuraObj
                    };
                    const context = vm.createContext(sandbox);
                    const executionPromise = script.runInContext(context);
                    await executionPromise;
                    // Drain in-flight ops from any un-awaited async work the
                    // cell fired off (see the pendingOps wrapping above) —
                    // draining can itself queue more (e.g. a .then() chain),
                    // so keep going until a pass adds nothing new.
                    let pendingOpsCount = -1;
                    while (pendingOps.length !== pendingOpsCount) {
                        pendingOpsCount = pendingOps.length;
                        await Promise.all(pendingOps);
                    }
                    await data.flushAll();
                } catch (e) {
                    status = 'error';
                    errorMessage = (e && e.stack) ? e.stack : String(e);
                } finally {
                    process.stdout.write = origStdoutWrite;
                    process.stderr.write = origStderrWrite;
                }

                const response = { id, status, stdout: stdoutBuf, stderr: stderrBuf };
                if (errorMessage) response.error = errorMessage;
                realStdoutWrite(JSON.stringify(response) + '\n');
            } finally {
                isExecuting = false;
            }
        });

        rl.on('close', resolve);
    });
}

async function main() {
    const storagePath = process.env.VURA_STORAGE_PATH;
    if (!storagePath) {
        console.error("VURA_STORAGE_PATH not set");
        process.exit(1);
    }

    const data = new DataManager(storagePath);
    const state = new StateManager();
    const metrics = new MetricsManager();

    const ioModule = {
        data,
        state,
        metrics,
        put: data.put.bind(data),
        get: data.get.bind(data),
        pack: data.pack.bind(data),
        unpack: data.unpack.bind(data),
        tables: data.tables.bind(data),
        saveTable: data.put.bind(data),
        save_table: data.put.bind(data),
        getTable: data.get.bind(data),
        get_table: data.get.bind(data),
        count: data.count.bind(data),
        saveNested: data.pack.bind(data),
        save_nested: data.pack.bind(data),
        loadReconstructed: data.unpack.bind(data),
        load_reconstructed: data.unpack.bind(data),
        flush: data.flush.bind(data),
        flushAll: data.flushAll.bind(data),
        append: data.append.bind(data),
        stream: data.stream.bind(data),
    };
    ioModule.io = ioModule;
    ioModule.default = ioModule;
    global.data = data;
    global.state = state;
    global.metrics = metrics;
    global.vura = { io: ioModule, data, state, metrics, ...ioModule };

    const Module = require('module');
    const _origResolve = Module._resolveFilename.bind(Module);
    Module._resolveFilename = function(request, parent, isMain, options) {
        if (
            request === '@vura/io' ||
            request === 'vura-io' ||
            request === 'vura_io' ||
            request === 'vura_bridge' ||
            request === 'vura' ||
            request === 'vura/io'
        ) {
            return request;
        }
        return _origResolve(request, parent, isMain, options);
    };

    const registerCache = (modName) => {
        require.cache[modName] = {
            id: modName,
            filename: modName,
            loaded: true,
            exports: ioModule,
            parent: null,
            children: [],
            paths: []
        };
    };

    registerCache('@vura/io');
    registerCache('vura-io');
    registerCache('vura_io');
    registerCache('vura_bridge');
    registerCache('vura');
    registerCache('vura/io');

    await serveForever(data, state, metrics);
}

main();
