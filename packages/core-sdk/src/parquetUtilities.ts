import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as parquet from 'parquetjs-lite';

// Global to store lineage
(global as any).__vuraLineage = { inputs: [], outputs: [] };

export class ParquetUtilities {
    /**
     * Writes an array of objects to a Parquet file.
     */
    static async writeParquet(filePath: string, dataArray: any[]): Promise<void> {
        const fileName = path.basename(filePath);
        (global as any).__vuraLineage.outputs.push({ namespace: "vura", name: fileName });

        if (!Array.isArray(dataArray) || dataArray.length === 0) {
            return;
        }

        const schemaObj: any = {};
        const firstRow = dataArray[0];

        // Ensure consistent keys across all rows
        const allKeys = new Set<string>();
        for (const row of dataArray) {
            Object.keys(row).forEach(k => allKeys.add(k));
        }

        for (const key of allKeys) {
            // Check the first non-null/undefined value for the key to determine type
            let sampleValue = null;
            for(const row of dataArray) {
                if (row[key] !== null && row[key] !== undefined) {
                    sampleValue = row[key];
                    break;
                }
            }

            if (sampleValue !== null) {
                if (typeof sampleValue === 'number') {
                    schemaObj[key] = { type: 'DOUBLE', optional: true };
                } else if (typeof sampleValue === 'boolean') {
                    schemaObj[key] = { type: 'BOOLEAN', optional: true };
                } else {
                    schemaObj[key] = { type: 'UTF8', optional: true };
                }
            } else {
                schemaObj[key] = { type: 'UTF8', optional: true };
            }
        }

        // Inject _vura_metadata column if gitHash, runId, or cellId are provided in env or explicitly passed
        const runId = process.env.VURA_RUN_ID || 'unknown_run';
        const cellId = process.env.VURA_CELL_ID || 'unknown_cell';
        const gitHash = process.env.VURA_GIT_HASH || 'unknown_hash';

        schemaObj['_vura_metadata'] = { type: 'UTF8', optional: true };

        const schema = new parquet.ParquetSchema(schemaObj);
        const writer = await parquet.ParquetWriter.openFile(schema, filePath);

        for (const row of dataArray) {
            const cleanRow: any = {};
            for (const key of Object.keys(schemaObj)) {
                if (key === '_vura_metadata') continue;
                let val = row[key];
                if (val === null || val === undefined) {
                    cleanRow[key] = null;
                } else if (schemaObj[key].type === 'UTF8') {
                    cleanRow[key] = String(val);
                } else {
                    cleanRow[key] = val;
                }
            }

            cleanRow['_vura_metadata'] = JSON.stringify({
                git_hash: gitHash,
                run_id: runId,
                cell_id: cellId
            });

            await writer.appendRow(cleanRow);
        }
        await writer.close();
    }

    /**
     * Reads a Parquet file and returns an array of objects.
     */
    static async readParquet(filePath: string): Promise<any[]> {
        const fileName = path.basename(filePath);
        (global as any).__vuraLineage.inputs.push({ namespace: "vura", name: fileName });

        if (!existsSync(filePath)) {
            throw new Error(`Parquet file not found: ${filePath}`);
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
}
