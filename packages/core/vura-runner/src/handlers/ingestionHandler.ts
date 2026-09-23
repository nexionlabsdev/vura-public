import * as path from 'path';
import * as fs from 'fs';
import { IVuraEnvironment, ICellLogger } from '../interfaces';
import csvParser from 'csv-parser';
import * as ExcelJS from 'exceljs';
// @ts-ignore
import * as parquet from 'parquetjs-lite';
import { DuckDbManager } from '../services/duckDbManager';
import * as arrow from 'apache-arrow';
import * as crypto from 'crypto';
export async function handleFileIngestion(
    relativePath: string,
    fileType: string,
    targetTable: string,
    sheetName: string | undefined,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    const notebookDir = env.notebookDir;
    const absolutePath = path.resolve(notebookDir, relativePath);

    if (!fs.existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`);
    }

    const duckDb = await DuckDbManager.getInstance(env);

    // If CSV or Parquet, DuckDB can ingest it instantly without reading to JS memory
    if (fileType === 'csv') {
        await duckDb.runQuery(`DROP TABLE IF EXISTS "${targetTable}"`);
        await duckDb.runQuery(`CREATE TABLE "${targetTable}" AS SELECT * FROM read_csv_auto('${absolutePath}')`);
        await logger.logText(`Successfully ingested CSV into table "${targetTable}".`);
        return;
    } else if (fileType === 'parquet') {
        await duckDb.runQuery(`DROP TABLE IF EXISTS "${targetTable}"`);
        await duckDb.runQuery(`CREATE TABLE "${targetTable}" AS SELECT * FROM read_parquet('${absolutePath}')`);
        await logger.logText(`Successfully ingested Parquet into table "${targetTable}".`);
        return;
    }

    // For Excel, fallback to manual read via exceljs
    if (fileType === 'excel') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(absolutePath);

        const worksheetsToImport = sheetName 
            ? [workbook.getWorksheet(sheetName)] 
            : workbook.worksheets;
            
        if (!worksheetsToImport || worksheetsToImport.length === 0 || !worksheetsToImport[0]) {
            throw new Error(`Sheet ${sheetName || 'default'} not found in ${absolutePath}`);
        }

        for (const worksheet of worksheetsToImport) {
            let records: any[] = [];
            const headers: string[] = [];
            worksheet!.getRow(1).eachCell((cell, colNumber) => {
                headers[colNumber] = cell.value?.toString() || `Col${colNumber}`;
            });

            worksheet!.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return; // skip header
                const rowData: any = {};
                row.eachCell((cell, colNumber) => {
                    rowData[headers[colNumber]] = cell.value;
                });
                records.push(rowData);
            });

            if (records.length === 0) {
                await logger.logText(`No records found in Excel sheet ${worksheet!.name}.`);
                continue;
            }

            const currentTargetTable = sheetName ? targetTable : `${targetTable}_${worksheet!.name}`;
            const table = arrow.tableFromJSON(records);
            const chunks = [];
            for await (const chunk of arrow.RecordBatchStreamWriter.writeAll(table)) {
                chunks.push(chunk);
            }
            await duckDb.saveTableArrowIPC(currentTargetTable, Buffer.concat(chunks));
            await logger.logText(`Successfully ingested ${records.length} Excel records into table "${currentTargetTable}".`);
        }
        return;
    } else if (fileType === 'json') {
        const fileContent = fs.readFileSync(absolutePath, 'utf-8');
        let dataArray = JSON.parse(fileContent);
        if (!Array.isArray(dataArray)) {
            dataArray = [dataArray];
        }

        const depthLimit = 5;
        const tables: { [key: string]: any[] } = {};

        function traverse(items: any[], currentName: string, parentId: string | null, depth: number) {
            if (depth > depthLimit) return;
            if (!tables[currentName]) tables[currentName] = [];

            for (const item of items) {
                if (item === null || item === undefined) continue;

                // Wrap primitive values in arrays into an object so they aren't lost
                const currentItem = typeof item !== 'object' ? { value: item } : item;

                const rowId = crypto.randomUUID();
                const flattenedRow: any = { Vura_ID: rowId };
                if (parentId) flattenedRow.Vura_Parent_ID = parentId;

                const metadata: any = { children: {} };

                for (const [key, value] of Object.entries(currentItem)) {
                    if (value !== null && value !== undefined && typeof value === 'object') {
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

        traverse(dataArray, targetTable, null, 1);

        const createdTables: string[] = [];
        for (const [tableName, records] of Object.entries(tables)) {
            if (records.length === 0) continue;

            const table = arrow.tableFromJSON(records);
            const chunks = [];
            for await (const chunk of arrow.RecordBatchStreamWriter.writeAll(table)) {
                chunks.push(chunk);
            }
            await duckDb.saveTableArrowIPC(tableName, Buffer.concat(chunks));
            createdTables.push(tableName);
        }
        
        if (createdTables.length > 1) {
            let msg = `Successfully ingested nested JSON into ${createdTables.length} tables:\n`;
            for (const t of createdTables) {
                msg += `  • ${t}\n`;
            }
            await logger.logText(msg);
        } else if (createdTables.length === 1) {
            await logger.logText(`Successfully ingested JSON into table "${createdTables[0]}".`);
        } else {
            await logger.logText(`No data found in JSON to ingest.`);
        }
        return;
    } else {
        throw new Error(`Unsupported file type: ${fileType}`);
    }
}
