import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore
import * as parquet from 'parquetjs-lite';
import { shredJson, unshredJson, Manifest } from './shredder';

export class DataManager {
    private storagePath: string;
    private manifests: Map<string, Manifest> = new Map();

    constructor(storagePath?: string) {
        this.storagePath = storagePath || process.env.VURA_STORAGE_PATH || process.cwd();
    }

    public setStoragePath(p: string) {
        this.storagePath = p;
    }

    private getParquetPath(tableName: string): string {
        return path.join(this.storagePath, `${tableName}.parquet`);
    }

    private emitMapping(variableName: string, filePath: string) {
        process.stderr.write(JSON.stringify({ type: 'vura_io_mapping', variable: variableName, path: filePath }) + '\n');
    }

    private async writeTableParquet(tableName: string, records: any[]): Promise<void> {
        const filePath = this.getParquetPath(tableName);
        if (!records || records.length === 0) {
            // Write empty file marker or schema if needed
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

        const schemaObj: Record<string, any> = {};
        for (const key of Object.keys(records[0])) {
            let sampleVal: any = null;
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
            const cleanRow: Record<string, any> = {};
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

    private async readTableParquet(tableName: string): Promise<any[]> {
        const filePath = this.getParquetPath(tableName);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const reader = await parquet.ParquetReader.openFile(filePath);
        const cursor = reader.getCursor();
        const records: any[] = [];
        let record: any = null;
        while ((record = await cursor.next())) {
            records.push(record);
        }
        await reader.close();
        return records;
    }

    public async pack(name: string, obj: any): Promise<string[]> {
        const { tables, manifest, tableNames } = shredJson(name, obj);
        this.manifests.set(name, manifest);

        for (const [tableName, records] of Object.entries(tables)) {
            await this.writeTableParquet(tableName, records);
        }

        const metaTableName = `__vura_meta_${name}`;
        const metaRecords = [{ manifest: JSON.stringify(manifest) }];
        await this.writeTableParquet(metaTableName, metaRecords);

        const rootPath = this.getParquetPath(name);
        this.emitMapping(name, rootPath);

        return tableNames;
    }

    public async unpack(name: string): Promise<any> {
        let manifest = this.manifests.get(name);
        if (!manifest) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableParquet(metaTableName);
            if (!metaRecords || metaRecords.length === 0 || !metaRecords[0].manifest) {
                throw new Error(`Dataset metadata for '${name}' not found.`);
            }
            manifest = JSON.parse(metaRecords[0].manifest);
            this.manifests.set(name, manifest!);
        }

        const tables: Record<string, any[]> = {};
        for (const tableName of Object.keys(manifest!.tables)) {
            tables[tableName] = await this.readTableParquet(tableName);
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
        await this.writeTableParquet(name, records);
        const filePath = this.getParquetPath(name);
        this.emitMapping(name, filePath);
        return [name];
    }

    public async get(name: string): Promise<any> {
        const metaTableName = `__vura_meta_${name}`;
        const metaPath = this.getParquetPath(metaTableName);
        if (fs.existsSync(metaPath) || this.manifests.has(name)) {
            return await this.unpack(name);
        }
        return await this.readTableParquet(name);
    }

    public async tables(name?: string): Promise<string[]> {
        if (name) {
            const metaTableName = `__vura_meta_${name}`;
            const metaRecords = await this.readTableParquet(metaTableName);
            if (metaRecords && metaRecords.length > 0 && metaRecords[0].manifest) {
                const manifest: Manifest = JSON.parse(metaRecords[0].manifest);
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

export const data = new DataManager();
