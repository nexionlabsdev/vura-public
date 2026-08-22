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
    if (typeof val === 'bigint') {
        const num = Number(val);
        return Number.isSafeInteger(num) ? num : val.toString();
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
        if (typeof val.scale === 'number' && typeof val.value === 'bigint') {
            return Number(val.value) / Math.pow(10, val.scale);
        }
        if (val instanceof Date) return val.toISOString();
        if (typeof val.micros === 'bigint') {
            return new Date(Number(val.micros / 1000n)).toISOString();
        }
        if (typeof val.days === 'number' || typeof val.months === 'number') {
            return val.toString();
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
        if (!DuckDbManager.instances.has(id)) {
            const mgr = new DuckDbManager();
            await mgr.initialize(env, id);
            DuckDbManager.instances.set(id, mgr);
        }
        return DuckDbManager.instances.get(id)!;
    }

    public static async createIsolated(): Promise<DuckDbManager> {
        const mgr = new DuckDbManager();
        mgr.dbPath = ':memory:';
        mgr.db = await DuckDBInstance.create(':memory:');
        mgr.connection = await mgr.db.connect();
        try { await mgr.runQuery("PRAGMA memory_limit='1GB'"); } catch {}
        return mgr;
    }

    private async initialize(env: IVuraEnvironment, id: string) {
        if (!env.storagePath) {
            throw new Error("Storage path is required to run DuckDB.");
        }
        await fs.mkdir(env.storagePath, { recursive: true });

        this.dbPath = path.join(env.storagePath, `staging_${id}.duckdb`);

        this.db = await DuckDBInstance.create(this.dbPath);
        this.connection = await this.db.connect();

        // Setup limit to 1GB and load Arrow extension if available
        await this.runQuery("PRAGMA memory_limit='1GB'");
        try { await this.runQuery("INSTALL arrow"); } catch {}
        try { await this.runQuery("LOAD arrow"); } catch {}

        await this.syncStorageViews(env);
    }

    public async syncStorageViews(env: IVuraEnvironment): Promise<void> {
        if (!env.storagePath) return;
        try {
            const files = await fs.readdir(env.storagePath);
            for (const file of files) {
                if (file.endsWith('.parquet') && !file.startsWith('__vura_meta_')) {
                    const tableName = file.replace(/\.parquet$/, '');
                    const parquetPath = path.join(env.storagePath, file);
                    await this.updateView(tableName, parquetPath);
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
        const parsedTable = arrow.tableFromIPC([ipcData]);
        const arr = parsedTable.toArray();
        if (arr.length === 0) return;

        const tempJson = this.dbPath + `_temp_arrow_${Date.now()}.json`;
        await fs.writeFile(tempJson, JSON.stringify(arr, (k, v) => typeof v === 'bigint' ? Number(v) : v), 'utf8');

        try {
            try { await this.runQuery(`DROP VIEW IF EXISTS "${tableName}"`); } catch { }
            try { await this.runQuery(`DROP TABLE IF EXISTS "${tableName}"`); } catch { }
            await this.runQuery(`CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tempJson}')`);
        } finally {
            await fs.unlink(tempJson).catch(() => {});
        }
    }

    /** Export a DuckDB table to a parquet file so the Python sidecar can read it with get_table(). */
    public async exportTableToParquet(tableName: string, storagePath: string): Promise<void> {
        const parquetPath = path.join(storagePath, `${tableName}.parquet`).replace(/\\/g, '/');
        await this.runQuery(`COPY "${tableName}" TO '${parquetPath}' (FORMAT PARQUET)`);
    }

    public async updateView(viewName: string, parquetFilePath: string): Promise<void> {
        const sql = `CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${parquetFilePath.replace(/\\/g, '/')}');`;
        await this.runQuery(sql);
    }

    public async dropView(viewName: string): Promise<void> {
        const sql = `DROP VIEW IF EXISTS "${viewName}";`;
        await this.runQuery(sql);
    }

    public dispose() {
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
}
