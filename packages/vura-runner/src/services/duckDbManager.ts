import { IVuraEnvironment } from '../interfaces';
import * as duckdb from 'duckdb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as arrow from 'apache-arrow';

export class DuckDbManager {
    private static instances: Map<string, DuckDbManager> = new Map();
    private db?: duckdb.Database;
    private connection?: duckdb.Connection;
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
        await new Promise<void>((resolve, reject) => {
            mgr.db = new duckdb.Database(':memory:', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        mgr.connection = mgr.db!.connect();
        try { await mgr.runQuery("PRAGMA memory_limit='1GB'"); } catch {}
        return mgr;
    }

    private async initialize(env: IVuraEnvironment, id: string) {
        if (!env.storagePath) {
            throw new Error("Storage path is required to run DuckDB.");
        }
        await fs.mkdir(env.storagePath, { recursive: true });

        this.dbPath = path.join(env.storagePath, `staging_${id}.duckdb`);

        await new Promise<void>((resolve, reject) => {
            this.db = new duckdb.Database(this.dbPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        this.connection = this.db!.connect();

        // Setup limit to 1GB and load Arrow extension
        await this.runQuery("PRAGMA memory_limit='1GB'");
        try { await this.runQuery("INSTALL arrow"); } catch {}
        try { await this.runQuery("LOAD arrow"); } catch {}
    }

    public async runQuery(sql: string, params: any[] = []): Promise<any[]> {
        return new Promise((resolve, reject) => {
            this.connection!.all(sql, ...params, (err: any, res: any) => {
                if (err) reject(err);
                else resolve(res);
            });
        });
    }

    // Runs a query and returns Arrow IPC buffer
    public async queryArrowIPC(sql: string): Promise<Buffer> {
        const records = await this.runQuery(sql);
        if (!records || records.length === 0) {
            return Buffer.alloc(0);
        }

        const table = arrow.tableFromJSON(records);
        const recordBatchStream = arrow.RecordBatchStreamWriter.writeAll(table);
        const chunks = [];
        for await (const chunk of recordBatchStream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    public async getTableArrowIPC(tableName: string): Promise<Buffer> {
        return this.queryArrowIPC(`SELECT * FROM "${tableName}"`);
    }

    public async saveTableArrowIPC(tableName: string, ipcData: Buffer): Promise<void> {
        // DuckDB's native node API db.register_buffer can cause a C++ abort trap
        // due to Arrow JS and Node.js underlying Buffer unalignment differences.
        // As a highly robust fallback for cross-OS stability, we unpack the Arrow array,
        // serialize to a quick JSON, and load instantly using DuckDB's blazing fast read_json_auto
        const parsedTable = arrow.tableFromIPC([ipcData]);
        const arr = parsedTable.toArray();
        if (arr.length === 0) return;

        const tempJson = this.dbPath + `_temp_arrow_${Date.now()}.json`;
        await fs.writeFile(tempJson, JSON.stringify(arr, (k, v) => typeof v === 'bigint' ? Number(v) : v), 'utf8');

        try {
            // DuckDB's IF EXISTS only suppresses "does not exist" errors, not catalog
            // type mismatches — DROP VIEW on an existing TABLE (or vice versa) still
            // throws. Guard each drop independently so a stale object from a previous
            // run of the opposite type doesn't block the CREATE TABLE below.
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
        if (this.db) {
            try { this.db.close(); } catch(e) {}
        }
        if (this.connection) {
            // connection close if exposed
        }
    }
}
