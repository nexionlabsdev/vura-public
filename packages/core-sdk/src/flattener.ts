import { v4 as uuidv4 } from 'uuid';
import { ParquetUtilities } from './parquetUtilities';
import * as path from 'path';

export interface FlattenConfig {
    depthLimit?: number;
    storagePath: string;
}

export class AutoSchemaFlattener {
    /**
     * Recursively flattens JSON objects/arrays, extracting nested arrays or objects into sub-tables.
     * Generates `Vura_Parent_ID` GUIDs for linkage, injects `_vura_metadata`, and saves as Parquet files.
     *
     * @param data The JSON array or object to flatten
     * @param baseName The base name for the root table (e.g., variable name)
     * @param config Configuration options
     * @returns A map of table names to their flattened records
     */
    static async flattenAndSave(data: any, baseName: string, config: FlattenConfig): Promise<Record<string, any[]>> {
        const depthLimit = config.depthLimit ?? 5;
        const tables: Record<string, any[]> = {};

        const dataArray = Array.isArray(data) ? data : [data];

        function traverse(items: any[], currentName: string, parentId: string | null, depth: number) {
            if (depth > depthLimit) return;

            if (!tables[currentName]) {
                tables[currentName] = [];
            }

            for (const item of items) {
                if (!item || typeof item !== 'object') continue;

                const rowId = uuidv4();
                const flattenedRow: any = {
                    Vura_ID: rowId,
                };

                if (parentId) {
                    flattenedRow.Vura_Parent_ID = parentId;
                }

                // Metadata to store reconstruction mapping
                const metadata: any = {
                    children: {}
                };

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

        traverse(dataArray, baseName, null, 1);

        // Save tables as Parquet files
        for (const [tableName, records] of Object.entries(tables)) {
            const filePath = path.join(config.storagePath, `${tableName}.parquet`);
            await ParquetUtilities.writeParquet(filePath, records);
        }

        return tables;
    }

    /**
     * Reconstructs nested JSON objects from flattened tables using `_vura_metadata`.
     */
    static async loadAndReconstruct(baseName: string, storagePath: string): Promise<any[]> {
        const rootFilePath = path.join(storagePath, `${baseName}.parquet`);
        const rootRecords = await ParquetUtilities.readParquet(rootFilePath);

        async function resolveChildren(records: any[]): Promise<any[]> {
            const resolvedRecords = [];

            for (const record of records) {
                const reconstructedObj: any = { ...record };
                delete reconstructedObj.Vura_ID;
                delete reconstructedObj.Vura_Parent_ID;

                let metadata: any = null;
                if (reconstructedObj._vura_metadata) {
                    try {
                        metadata = JSON.parse(reconstructedObj._vura_metadata);
                    } catch (e) {
                        // ignore malformed metadata
                    }
                    delete reconstructedObj._vura_metadata;
                }

                if (metadata && metadata.children) {
                    for (const [key, childInfo] of Object.entries<any>(metadata.children)) {
                        const childTableName = childInfo.table;
                        const childFilePath = path.join(storagePath, `${childTableName}.parquet`);

                        try {
                            const childRecords = await ParquetUtilities.readParquet(childFilePath);
                            // Filter children belonging to this record
                            const myChildren = childRecords.filter(c => c.Vura_Parent_ID === record.Vura_ID);

                            const resolvedChildren = await resolveChildren(myChildren);

                            if (childInfo.type === 'object') {
                                reconstructedObj[key] = resolvedChildren.length > 0 ? resolvedChildren[0] : null;
                            } else {
                                reconstructedObj[key] = resolvedChildren;
                            }
                        } catch (e) {
                            // Parquet might not exist if it was empty
                            reconstructedObj[key] = childInfo.type === 'object' ? null : [];
                        }
                    }
                }

                resolvedRecords.push(reconstructedObj);
            }

            return resolvedRecords;
        }

        return await resolveChildren(rootRecords);
    }
}
