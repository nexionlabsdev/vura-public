const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const parquet = require('parquetjs-lite');

class VuraBridgeLibrary {
    constructor(storagePath) {
        this.storagePath = storagePath;
        // Tracks in-flight calls to this object's own async methods, so the
        // sidecar's serve loop can tell whether fire-and-forget cell code
        // (`vura_bridge.save(...).catch(...)` without an `await` — the only
        // option for top-level async, since cell code is transformed to CJS,
        // which doesn't support top-level await) has actually finished before
        // sending the response back, without depending on Node's internal
        // handle/request counters (which don't reliably track fs.promises-
        // based I/O, e.g. what parquetjs-lite uses under the hood).
        this.pendingCalls = new Set();

        // Auto-bind all methods so destructured imports (import { saveNested }) don't lose `this` context
        const methods = Object.getOwnPropertyNames(VuraBridgeLibrary.prototype).filter(m => m !== 'constructor');
        for (const method of methods) {
            const original = VuraBridgeLibrary.prototype[method];
            if (typeof original !== 'function') continue;
            this[method] = (...args) => {
                const result = original.apply(this, args);
                if (result && typeof result.then === 'function') {
                    this.pendingCalls.add(result);
                    result.finally(() => this.pendingCalls.delete(result));
                }
                return result;
            };
        }
    }

    async save(variableName, dataArray) {
        if (!Array.isArray(dataArray) || dataArray.length === 0) {
            return;
        }

        const depthLimit = parseInt(process.env.VURA_DEPTH_LIMIT || '5', 10);

        // If the data has nested objects or arrays, use the automated flattener
        const hasNested = dataArray.some(row => Object.values(row).some(v => v && typeof v === 'object'));
        if (hasNested && this.save_automated) {
            return await this.save_automated(variableName, dataArray, depthLimit);
        }

        const filePath = path.join(this.storagePath, `${variableName}.parquet`);

        // Simple schema inference for parquetjs-lite
        const schemaObj = {};
        const firstRow = dataArray[0];
        for (const [key, value] of Object.entries(firstRow)) {
            if (typeof value === 'number') {
                schemaObj[key] = { type: 'DOUBLE' };
            } else if (typeof value === 'boolean') {
                schemaObj[key] = { type: 'BOOLEAN' };
            } else {
                schemaObj[key] = { type: 'UTF8' };
            }
        }

        const schema = new parquet.ParquetSchema(schemaObj);
        const writer = await parquet.ParquetWriter.openFile(schema, filePath);

        for (const row of dataArray) {
            const cleanRow = {};
            for (const key of Object.keys(schemaObj)) {
                let val = row[key];
                if (val === null || val === undefined) {
                    cleanRow[key] = schemaObj[key].type === 'UTF8' ? '' : 0;
                } else if (schemaObj[key].type === 'UTF8') {
                    cleanRow[key] = String(val);
                } else {
                    cleanRow[key] = val;
                }
            }
            await writer.appendRow(cleanRow);
        }
        await writer.close();

        process.stderr.write(JSON.stringify({ type: 'vura_bridge_mapping', variable: variableName, path: filePath }) + '\n');
    }

    async load(variableName) {
        const filePath = path.join(this.storagePath, `${variableName}.parquet`);
        if (!fs.existsSync(filePath)) {
            const available = this.list_tables();
            throw new Error(`Table '${variableName}' not found. Available tables: [${available.join(', ')}]`);
        }

        const reader = await parquet.ParquetReader.openFile(filePath);
        const cursor = reader.getCursor();
        const records = [];
        let record = null;
        while (record = await cursor.next()) {
            records.push(record);
        }
        await reader.close();
        return records;
    }

    // Aliases — camelCase and snake_case variants all work
    async get_table(variableName)           { return this.load(variableName); }
    async save_table(variableName, data)    { return this.save(variableName, data); }
    async saveNested(variableName, data)    { return this.save_automated(variableName, Array.isArray(data) ? data : [data]); }
    async loadReconstructed(variableName)   { return this.load_reconstructed(variableName); }
    async save_nested(variableName, data)   { return this.saveNested(variableName, data); }
    async load_reconstructed_alias(n)       { return this.load_reconstructed(n); }

    list_tables() {
        return fs.readdirSync(this.storagePath)
            .filter(f => f.endsWith('.parquet'))
            .map(f => f.replace(/\.parquet$/, ''));
    }

    async save_automated(variableName, dataArray, depthLimit = 5) {
        // Implementation provided via Core SDK equivalent or custom logic here
        // The sidecar is independent of SDK for polyglot execution, so we embed logic
        const crypto = require('crypto');
        const uuidv4 = () => crypto.randomUUID();

        const tables = {};

        function traverse(items, currentName, parentId, depth) {
            if (depth > depthLimit) return;
            if (!tables[currentName]) tables[currentName] = [];

            for (const item of items) {
                if (!item || typeof item !== 'object') continue;

                const rowId = uuidv4();
                const flattenedRow = { Vura_ID: rowId };
                if (parentId) flattenedRow.Vura_Parent_ID = parentId;

                const metadata = { children: {} };

                for (const [key, value] of Object.entries(item)) {
                    if (value && typeof value === 'object') {
                        const childTableName = `${currentName}_${key}`;
                        metadata.children[key] = {
                            type: Array.isArray(value) ? 'array' : 'object',
                            table: childTableName
                        };

                        if (Array.isArray(value)) {
                            traverse(value, childTableName, rowId, depth + 1);
                        } else {
                            traverse([value], childTableName, rowId, depth + 1);
                        }
                    } else {
                        flattenedRow[key] = value;
                    }
                }

                flattenedRow._vura_metadata = JSON.stringify(metadata);
                tables[currentName].push(flattenedRow);
            }
        }

        const arr = Array.isArray(dataArray) ? dataArray : [dataArray];
        traverse(arr, variableName, null, 1);

        for (const [tableName, records] of Object.entries(tables)) {
            if (records.length === 0) continue;
            const filePath = path.join(this.storagePath, `${tableName}.parquet`);

            const schemaObj = {};
            for (const key of Object.keys(records[0])) {
                let sampleValue = null;
                for (const row of records) {
                    if (row[key] !== null && row[key] !== undefined) {
                        sampleValue = row[key];
                        break;
                    }
                }
                if (typeof sampleValue === 'number') {
                    schemaObj[key] = { type: 'DOUBLE', optional: true };
                } else if (typeof sampleValue === 'boolean') {
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
                    cleanRow[key] = row[key] === null || row[key] === undefined ? null :
                                    (schemaObj[key].type === 'UTF8' ? String(row[key]) : row[key]);
                }
                await writer.appendRow(cleanRow);
            }
            await writer.close();

            if (tableName === variableName) {
                process.stderr.write(JSON.stringify({ type: 'vura_bridge_mapping', variable: variableName, path: filePath }) + '\n');
            }
        }
    }

    async load_reconstructed(variableName) {
        const loadTable = async (tableName) => {
            const filePath = path.join(this.storagePath, `${tableName}.parquet`);
            if (!fs.existsSync(filePath)) return [];
            const reader = await parquet.ParquetReader.openFile(filePath);
            const cursor = reader.getCursor();
            const records = [];
            let record = null;
            while (record = await cursor.next()) records.push(record);
            await reader.close();
            return records;
        };

        const resolveChildren = async (records) => {
            const resolved = [];
            for (const record of records) {
                const rec = { ...record };
                const vuraId = rec.Vura_ID;
                delete rec.Vura_ID;
                delete rec.Vura_Parent_ID;

                let metadata = null;
                if (rec._vura_metadata) {
                    try { metadata = JSON.parse(rec._vura_metadata); } catch (e) {}
                    delete rec._vura_metadata;
                }

                if (metadata && metadata.children) {
                    for (const [key, childInfo] of Object.entries(metadata.children)) {
                        const childRecords = await loadTable(childInfo.table);
                        const myChildren = childRecords.filter(c => c.Vura_Parent_ID === vuraId);
                        const resolvedChildren = await resolveChildren(myChildren);

                        if (childInfo.type === 'object') {
                            rec[key] = resolvedChildren.length > 0 ? resolvedChildren[0] : null;
                        } else {
                            rec[key] = resolvedChildren;
                        }
                    }
                }
                resolved.push(rec);
            }
            return resolved;
        };

        const rootRecords = await loadTable(variableName);
        if (rootRecords.length === 0) {
            throw new Error(`Parquet file for variable ${variableName} not found.`);
        }
        return await resolveChildren(rootRecords);
    }
}

/**
 * Persistent worker loop: reads one NDJSON request per stdin line, executes
 * the code in a brand-new vm context every time (so no variable/global state
 * ever survives between cell runs — only the process and its already-loaded
 * `require()` modules stay warm), and writes one NDJSON response per line.
 *
 * Request:  {"id": string, "code": string, "filename"?: string, "env"?: {"VURA_DATAVERSE_TOKEN": string, "VURA_DEPTH_LIMIT": string}}
 * Response: {"id": string, "status": "ok"|"error", "stdout": string, "stderr": string, "error"?: string}
 */
async function serveForever(vura_bridge) {
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
        // Capture everything the cell writes (console.log, vura_bridge's own
        // stderr markers, etc.) without it interleaving with our NDJSON
        // control channel on the real stdout.
        process.stdout.write = (chunk) => { stdoutBuf += chunk.toString(); return true; };
        process.stderr.write = (chunk) => { stderrBuf += chunk.toString(); return true; };

        let status = 'ok';
        let errorMessage;
        const cellFilename = filename || path.join(process.cwd(), 'cell.js');

        try {
            // esbuild transforms cell code to CJS (see handler), which doesn't
            // support top-level await — so fire-and-forget async calls like
            // `doWork().catch(console.error)` are legitimate, not a bug, in
            // cell code. The wrapper below can't force those to be awaited.
            const wrapped = `(async () => {\n${code}\n})()`;
            const script = new vm.Script(wrapped, { filename: cellFilename });
            const sandbox = {
                require, module, exports,
                __dirname: path.dirname(cellFilename),
                __filename: cellFilename,
                console, process, Buffer,
                setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
                URL, URLSearchParams, TextEncoder, TextDecoder,
                vura_bridge
            };
            const context = vm.createContext(sandbox);
            await script.runInContext(context);

            // Safety net for that fire-and-forget code: a fresh spawn-per-cell
            // process used to mask this entirely — Node won't exit while a
            // promise chain is still pending, so the parent's "wait for
            // process exit" accidentally waited for dangling work too. This
            // process never exits between cells, so there's no such signal
            // here. Wait for any vura_bridge calls the cell fired without
            // awaiting to actually finish, up to a bounded cap so a call that
            // never settles can't hang the whole notebook.
            for (let i = 0; i < 200 && vura_bridge.pendingCalls.size > 0; i++) {
                await Promise.race([
                    Promise.allSettled([...vura_bridge.pendingCalls]),
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

    const vura_bridge = new VuraBridgeLibrary(storagePath);

    // Make vura_bridge available as:
    //   1. global.vura_bridge              → bare `vura_bridge.save(...)` in cell code
    //   2. require("vura_bridge")          → module import style
    global.vura_bridge = vura_bridge;

    // Hook _resolveFilename so Node doesn't throw before reaching require.cache
    const Module = require('module');
    const _origResolve = Module._resolveFilename.bind(Module);
    Module._resolveFilename = function(request, parent, isMain, options) {
        if (request === 'vura_bridge') return 'vura_bridge';
        return _origResolve(request, parent, isMain, options);
    };
    require.cache['vura_bridge'] = {
        id: 'vura_bridge',
        filename: 'vura_bridge',
        loaded: true,
        exports: vura_bridge,
        parent: null,
        children: [],
        paths: []
    };

    await serveForever(vura_bridge);
}

main();
