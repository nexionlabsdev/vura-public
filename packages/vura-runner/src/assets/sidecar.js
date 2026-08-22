const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const crypto = require('crypto');
const parquet = require('parquetjs-lite');

class Shredder {
    static shredJson(datasetName, obj) {
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
                    if (!meta.node_type) meta.node_type = 'array';
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
            } else if (node && typeof node === 'object') {
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

            if (item && typeof item === 'object') {
                for (const [key, value] of Object.entries(item)) {
                    if (!meta.field_order.includes(key)) {
                        meta.field_order.push(key);
                    }

                    if (value === null || value === undefined) {
                        meta.field_types[key] = 'null';
                        row[key] = null;
                    } else if (typeof value === 'object') {
                        const childTableName = `${tableName}_${key}`;
                        meta.field_types[key] = Array.isArray(value) ? 'array' : 'object';
                        meta.children[key] = childTableName;
                        processNode(value, childTableName, tableName, key, rowId, 0);
                    } else {
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

    static unshredJson(manifest, tables) {
        function reconstructNode(tableName, parentId) {
            const meta = manifest.tables[tableName];
            if (!meta) return null;

            const tableRows = (tables[tableName] || []).filter(
                r => (parentId === null ? (!r._vura_parent_id || r._vura_parent_id === 'null') : r._vura_parent_id === parentId)
            );

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
                    } else {
                        item[key] = childVal;
                    }
                } else if (key in row) {
                    item[key] = row[key];
                } else {
                    item[key] = null;
                }
            }
            return item;
        }

        return reconstructNode(manifest.root_table, null);
    }
}

class DataManager {
    constructor(storagePath) {
        this.storagePath = storagePath;
        this.manifests = new Map();
        this.pendingCalls = new Set();

        const methods = ['put', 'pack', 'get', 'unpack', 'tables'];
        for (const method of methods) {
            const orig = this[method].bind(this);
            this[method] = (...args) => {
                const res = orig(...args);
                if (res && typeof res.then === 'function') {
                    this.pendingCalls.add(res);
                    res.finally(() => this.pendingCalls.delete(res));
                }
                return res;
            };
        }
    }

    getParquetPath(tableName) {
        return path.join(this.storagePath, `${tableName}.parquet`);
    }

    emitMapping(variableName, filePath) {
        process.stderr.write(JSON.stringify({ type: 'vura_io_mapping', variable: variableName, path: filePath }) + '\n');
    }

    async writeTableParquet(tableName, records) {
        const filePath = this.getParquetPath(tableName);
        if (!records || records.length === 0) {
            const schema = new parquet.ParquetSchema({
                _vura_id: { type: 'UTF8', optional: true },
                _vura_parent_id: { type: 'UTF8', optional: true },
                _vura_index: { type: 'DOUBLE', optional: true },
                _vura_value: { type: 'UTF8', optional: true }
            });
            const writer = await parquet.ParquetWriter.openFile(schema, filePath);
            await writer.close();
            return;
        }

        const schemaObj = {};
        for (const key of Object.keys(records[0])) {
            let sampleVal = null;
            for (const row of records) {
                if (row[key] !== null && row[key] !== undefined) {
                    sampleVal = row[key];
                    break;
                }
            }
            if (typeof sampleVal === 'number') {
                schemaObj[key] = { type: 'DOUBLE', optional: true };
            } else if (typeof sampleVal === 'boolean') {
                schemaObj[key] = { type: 'BOOLEAN', optional: true };
            } else {
                schemaObj[key] = { type: 'UTF8', optional: true };
            }
        }

        const schema = new parquet.ParquetSchema(schemaObj);
        const writer = await parquet.ParquetWriter.openFile(schema, filePath);

        for (const row of records) {
            const cleanRow = {};
            for (const key of Object.keys(schemaObj)) {
                const val = row[key];
                if (val === null || val === undefined) {
                    cleanRow[key] = null;
                } else if (schemaObj[key].type === 'UTF8') {
                    cleanRow[key] = String(val);
                } else {
                    cleanRow[key] = val;
                }
            }
            await writer.appendRow(cleanRow);
        }
        await writer.close();
    }

    async readTableParquet(tableName) {
        const filePath = this.getParquetPath(tableName);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const reader = await parquet.ParquetReader.openFile(filePath);
        const cursor = reader.getCursor();
        const records = [];
        let record = null;
        while ((record = await cursor.next())) {
            records.push(record);
        }
        await reader.close();
        return records;
    }

    async pack(name, obj) {
        const { tables, manifest, tableNames } = Shredder.shredJson(name, obj);
        this.manifests.set(name, manifest);

        for (const [tableName, records] of Object.entries(tables)) {
            await this.writeTableParquet(tableName, records);
            this.emitMapping(tableName, this.getParquetPath(tableName));

            if (tableName.startsWith(`${name}_`)) {
                const shortKey = tableName.substring(name.length + 1);
                if (shortKey) {
                    this.emitMapping(shortKey, this.getParquetPath(tableName));
                }
            }
        }

        const metaTableName = `__vura_meta_${name}`;
        const metaRecords = [{ manifest: JSON.stringify(manifest) }];
        await this.writeTableParquet(metaTableName, metaRecords);

        return tableNames;
    }

    async unpack(name) {
        let manifest = this.manifests.get(name);
        if (!manifest) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableParquet(metaTableName);
            if (!metaRecords || metaRecords.length === 0 || !metaRecords[0].manifest) {
                throw new Error(`Dataset metadata for '${name}' not found.`);
            }
            manifest = JSON.parse(metaRecords[0].manifest);
            this.manifests.set(name, manifest);
        }

        const tables = {};
        for (const tableName of Object.keys(manifest.tables)) {
            tables[tableName] = await this.readTableParquet(tableName);
        }

        return Shredder.unshredJson(manifest, tables);
    }

    async put(name, obj) {
        const isNested = (val) => {
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
        await this.writeTableParquet(name, records);
        const filePath = this.getParquetPath(name);
        this.emitMapping(name, filePath);
        return [name];
    }

    async get(name) {
        const metaTableName = `__vura_meta_${name}`;
        const metaPath = this.getParquetPath(metaTableName);
        if (fs.existsSync(metaPath) || this.manifests.has(name)) {
            return await this.unpack(name);
        }
        return await this.readTableParquet(name);
    }

    async tables(name) {
        if (name) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableParquet(metaTableName);
            if (metaRecords && metaRecords.length > 0 && metaRecords[0].manifest) {
                const manifest = JSON.parse(metaRecords[0].manifest);
                return Object.keys(manifest.tables);
            }
            return [name];
        }

        if (!fs.existsSync(this.storagePath)) return [];
        return fs.readdirSync(this.storagePath)
            .filter(f => f.endsWith('.parquet'))
            .map(f => f.replace(/\.parquet$/, ''))
            .filter(f => !f.startsWith('__vura_meta_'));
    }
}

class StateManager {
    constructor() {
        this.store = new Map();
    }

    set(key, value) {
        this.store.set(key, value);
    }

    get(key, defaultValue = null) {
        return this.store.has(key) ? this.store.get(key) : defaultValue;
    }

    get context() {
        return {
            storagePath: process.env.VURA_STORAGE_PATH || '',
            notebookId: process.env.VURA_NOTEBOOK_ID || 'default',
            depthLimit: parseInt(process.env.VURA_DEPTH_LIMIT || '5', 10),
            env: process.env
        };
    }
}

class MetricsManager {
    track(name, value, step = null) {
        const payload = { type: 'vura_metric', name, value, step, timestamp: Date.now() };
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

async function serveForever(data, state, metrics) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let request;
        try { request = JSON.parse(trimmed); } catch { continue; }

        const { id, code, filename, env: envOverrides } = request;
        for (const [key, value] of Object.entries(envOverrides || {})) {
            process.env[key] = value == null ? '' : String(value);
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        const origStdoutWrite = process.stdout.write.bind(process.stdout);
        const origStderrWrite = process.stderr.write.bind(process.stderr);

        process.stdout.write = (chunk) => { stdoutBuf += chunk.toString(); return true; };
        process.stderr.write = (chunk) => { stderrBuf += chunk.toString(); return true; };

        let status = 'ok';
        let errorMessage;
        const cellFilename = filename || path.join(process.cwd(), 'cell.js');

        try {
            const wrapped = `(async () => {\n${code}\n})()`;
            const script = new vm.Script(wrapped, { filename: cellFilename });
            const vuraObj = { io: { data, state, metrics }, data, state, metrics };
            const sandbox = {
                require, module, exports,
                __dirname: path.dirname(cellFilename),
                __filename: cellFilename,
                console, process, Buffer,
                setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
                URL, URLSearchParams, TextEncoder, TextDecoder,
                data, state, metrics,
                vura: vuraObj
            };
            const context = vm.createContext(sandbox);
            await script.runInContext(context);

            for (let i = 0; i < 200 && data.pendingCalls.size > 0; i++) {
                await Promise.race([
                    Promise.allSettled([...data.pendingCalls]),
                    new Promise((r) => setTimeout(r, 25))
                ]);
            }
        } catch (e) {
            status = 'error';
            errorMessage = (e && e.stack) ? e.stack : String(e);
        } finally {
            process.stdout.write = origStdoutWrite;
            process.stderr.write = origStderrWrite;
        }

        const response = { id, status, stdout: stdoutBuf, stderr: stderrBuf };
        if (errorMessage) response.error = errorMessage;
        origStdoutWrite(JSON.stringify(response) + '\n');
    }
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
        saveNested: data.pack.bind(data),
        save_nested: data.pack.bind(data),
        loadReconstructed: data.unpack.bind(data),
        load_reconstructed: data.unpack.bind(data),
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
