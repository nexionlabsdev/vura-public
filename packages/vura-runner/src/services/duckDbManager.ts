import { IVuraEnvironment } from '../interfaces';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as arrow from 'apache-arrow';

if (!(BigInt.prototype as any).toJSON) {
    (BigInt.prototype as any).toJSON = function () {
        const num = Number(this);
        return Number.isSafeInteger(num) ? num : this.toString();
    };
}

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
    if (typeof val.days === 'number' || typeof val.months === 'number') {
        return val.toString();
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

export class DuckDbManager {
    private static instances: Map<string, DuckDbManager> = new Map();
    private db?: DuckDBInstance;
    private connection?: DuckDBConnection;
    private dbPath!: string;

    private constructor() { }

    public static async getInstance(env: IVuraEnvironment): Promise<DuckDbManager> {
        const id = env.notebookId || 'default';
        const existing = DuckDbManager.instances.get(id);
        if (existing && existing.connection) {
            return existing;
        }
        if (existing) {
            existing.dispose();
        }
        const mgr = new DuckDbManager();
        await mgr.initialize(env, id);
        DuckDbManager.instances.set(id, mgr);
        return mgr;
    }

    public static async createIsolated(): Promise<DuckDbManager> {
        const mgr = new DuckDbManager();
        mgr.dbPath = ':memory:';
        mgr.db = await DuckDBInstance.create(':memory:');
        mgr.connection = await mgr.db.connect();
        try { await mgr.runQuery("PRAGMA memory_limit='1GB'"); } catch {}
        return mgr;
    }

    public async connectSession(schemaName: string): Promise<DuckDbManager> {
        if (!this.db) {
            throw new Error("DuckDB instance is not initialized.");
        }
        const mgr = new DuckDbManager();
        mgr.db = this.db;
        mgr.dbPath = this.dbPath;
        mgr.connection = await this.db.connect();
        try { await mgr.runQuery(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`); } catch {}
        try { await mgr.runQuery(`SET search_path = '${schemaName}', 'main'`); } catch {}
        return mgr;
    }

    public async dropSchema(schemaName: string): Promise<void> {
        try {
            await this.runQuery(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } catch {}
    }

    private async initialize(env: IVuraEnvironment, id: string) {
        if (!env.storagePath) {
            throw new Error("Storage path is required to run DuckDB.");
        }
        await fs.mkdir(env.storagePath, { recursive: true });

        this.dbPath = path.join(env.storagePath, `staging_${id}.duckdb`);

        this.db = await DuckDBInstance.create(this.dbPath);
        this.connection = await this.db.connect();

        // Setup limit to 1GB
        await this.runQuery("PRAGMA memory_limit='1GB'");

        await this.syncStorageViews(env);
    }

    public async syncStorageViews(env: IVuraEnvironment): Promise<void> {
        if (!env.storagePath) return;
        try {
            const existing = await this.runQuery(
                `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main'`
            );
            const baseTables = new Set(
                existing.filter((r: any) => r.table_type === 'BASE TABLE').map((r: any) => r.table_name)
            );

            const files = await fs.readdir(env.storagePath);
            for (const file of files) {
                if ((file.endsWith('.parquet') || file.endsWith('.arrow')) && !file.startsWith('__vura_meta_')) {
                    const tableName = file.replace(/\.(parquet|arrow)$/, '');
                    if (!baseTables.has(tableName)) {
                        const filePath = path.join(env.storagePath, file);
                        await this.updateView(tableName, filePath);
                    }
                }
            }
        } catch { }
    }

    public async runQuery(sql: string, params: any[] = []): Promise<any[]> {
        if (!this.connection) {
            throw new Error("DuckDB connection is not initialized.");
        }
        const reader = await this.connection.runAndReadAll(sql, params);
        const colNames = reader.columnNames();
        const rows = reader.getRows();
        return rows.map((r: any[]) =>
            Object.fromEntries(colNames.map((col, idx) => [col, normalizeValue(r[idx])]))
        );
    }

    // Runs a query and returns Arrow IPC buffer
    public async queryArrowIPC(sql: string): Promise<Buffer> {
        const records = await this.runQuery(sql);
        if (!records || records.length === 0) {
            return Buffer.alloc(0);
        }

        const table = arrow.tableFromJSON(records);
        const recordBatchStream = arrow.RecordBatchStreamWriter.writeAll(table);
        const chunks: Uint8Array[] = [];
        for await (const chunk of recordBatchStream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    public async getTableArrowIPC(tableName: string): Promise<Buffer> {
        return this.queryArrowIPC(`SELECT * FROM "${tableName}"`);
    }

    public async saveTableArrowIPC(tableName: string, ipcData: Buffer): Promise<void> {
        if (!ipcData || ipcData.length === 0) return;
        const parsedTable = arrow.tableFromIPC([ipcData]);
        const rawRecords = parsedTable.toArray();
        if (rawRecords.length === 0) return;

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
                    }
                }
            }
        }

        try { await this.runQuery(`DROP VIEW IF EXISTS "${tableName}"`); } catch { }
        try { await this.runQuery(`DROP TABLE IF EXISTS "${tableName}"`); } catch { }

        const colDefs = Object.entries(schemaMap).map(([k, t]) => `"${k}" ${t}`).join(', ');
        await this.runQuery(`CREATE TABLE "${tableName}" (${colDefs})`);

        const appender = await this.connection!.createAppender(tableName, 'main');
        const keys = Object.keys(schemaMap);

        for (const r of rawRecords) {
            for (const k of keys) {
                const val = r ? r[k] : null;
                const type = schemaMap[k];
                if (val === null || val === undefined) {
                    appender.appendNull();
                } else if (type === 'BIGINT') {
                    appender.appendBigInt(BigInt(val));
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
    }

    /** Export a DuckDB table to a parquet file so Python and Node.js sidecars can read it. */
    public async exportTableToParquet(tableName: string, storagePath: string): Promise<void> {
        const parquetPath = path.join(storagePath, `${tableName}.parquet`).replace(/\\/g, '/');
        await this.runQuery(`COPY "${tableName}" TO '${parquetPath}' (FORMAT PARQUET, PARQUET_VERSION 'v1')`);
    }

    /** Export all base tables in DuckDB to parquet files in storagePath so sidecars (Python/JS) can access them. */
    public async exportAllTablesToParquet(storagePath: string): Promise<void> {
        if (!storagePath) return;
        try {
            const tables = await this.runQuery(
                `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'`
            );
            for (const row of tables) {
                const tableName = row.table_name;
                if (tableName && !tableName.startsWith('__vura_meta_')) {
                    await this.exportTableToParquet(tableName, storagePath);
                }
            }
        } catch { }
    }

    public async updateView(viewName: string, filePath: string): Promise<void> {
        const safePath = filePath.replace(/\\/g, '/');
        const readQuery = filePath.endsWith('.arrow')
            ? `read_ipc('${safePath}')`
            : `read_parquet('${safePath}')`;
        try { await this.runQuery(`DROP TABLE IF EXISTS "${viewName}";`); } catch {}
        const sql = `CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM ${readQuery};`;
        await this.runQuery(sql);
    }

    public async dropView(viewName: string): Promise<void> {
        const sql = `DROP VIEW IF EXISTS "${viewName}";`;
        await this.runQuery(sql);
    }

    public dispose() {
        for (const [key, instance] of DuckDbManager.instances.entries()) {
            if (instance === this) {
                DuckDbManager.instances.delete(key);
            }
        }
        if (this.connection) {
            try {
                if (typeof (this.connection as any).disconnectSync === 'function') {
                    (this.connection as any).disconnectSync();
                }
            } catch (e) {}
            this.connection = undefined;
        }
        if (this.db) {
            this.db = undefined;
        }
    }

    public static disposeNotebook(notebookId: string) {
        const mgr = DuckDbManager.instances.get(notebookId);
        if (mgr) {
            mgr.dispose();
            DuckDbManager.instances.delete(notebookId);
        }
    }

    public static disposeAll() {
        for (const mgr of DuckDbManager.instances.values()) {
            mgr.dispose();
        }
        DuckDbManager.instances.clear();
    }
}
