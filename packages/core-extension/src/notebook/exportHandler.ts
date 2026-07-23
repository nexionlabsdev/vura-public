import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { stringify } from 'csv-stringify';
import { NotebookController } from '../notebookController';
import { resolveBrowserPath } from './browserPathHelper';
import * as ExcelJS from 'exceljs';
// @ts-ignore
import * as parquet from 'parquetjs-lite';

export async function handleGridExport(
    tableName: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const formatOptions = ['Excel (.xlsx)', 'CSV (.csv)', 'JSON (.json)', 'Parquet (.parquet)'];
    const format = await vscode.window.showQuickPick(formatOptions, {
        placeHolder: 'Select Export Format'
    });

    if (!format) return;

    let defaultExt = 'xlsx';
    if (format.includes('.csv')) defaultExt = 'csv';
    else if (format.includes('.json')) defaultExt = 'json';
    else if (format.includes('.parquet')) defaultExt = 'parquet';

    const filters: { [name: string]: string[] } = {};
    filters[format] = [defaultExt];

    const uri = await vscode.window.showSaveDialog({
        filters,
        defaultUri: vscode.Uri.file(`export_${tableName}.${defaultExt}`)
    });

    if (!uri) return;

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Exporting ${tableName} to ${defaultExt.toUpperCase()}…`,
            cancellable: false
        }, async () => {
            const { DuckDbManager } = require('../services/duckDbManager');
            const duckDb = await DuckDbManager.getInstance(context);
            let records: any[] = [];
            try {
                records = await duckDb.runQuery(`SELECT * FROM "${tableName}"`);
            } catch {
                throw new Error(`Table "${tableName}" not found in local DuckDB.`);
            }

            if (records.length === 0) {
                throw new Error(`Table "${tableName}" is empty — nothing to export.`);
            }

            // Coerce BigInt values (JSON.stringify / ExcelJS can't handle them)
            records = records.map(row => {
                const out: any = {};
                for (const [k, v] of Object.entries(row)) {
                    if (typeof v === 'bigint') {
                        out[k] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
                            ? Number(v)
                            : v.toString();
                    } else {
                        out[k] = v;
                    }
                }
                return out;
            });

            if (defaultExt === 'csv') {
                await new Promise<void>((resolve, reject) => {
                    stringify(records, { header: true })
                        .pipe(fs.createWriteStream(uri.fsPath))
                        .on('finish', resolve)
                        .on('error', reject);
                });
            } else if (defaultExt === 'json') {
                await fs.promises.writeFile(uri.fsPath, JSON.stringify(records, null, 2), 'utf8');
            } else if (defaultExt === 'parquet') {
                const schemaObj: any = {};
                for (const k of Object.keys(records[0])) {
                    let type = 'UTF8';
                    const sample = records[0][k];
                    if (typeof sample === 'number') {
                        type = Number.isInteger(sample) ? 'INT64' : 'DOUBLE';
                    } else if (typeof sample === 'boolean') {
                        type = 'BOOLEAN';
                    }
                    schemaObj[k] = { type, optional: true };
                }
                const schema = new parquet.ParquetSchema(schemaObj);
                const writer = await parquet.ParquetWriter.openFile(schema, uri.fsPath);
                for (const row of records) {
                    await writer.appendRow(row);
                }
                await writer.close();
            } else {
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet(tableName);
                worksheet.columns = Object.keys(records[0]).map(k => ({ header: k, key: k }));
                records.forEach(r => worksheet.addRow(r));
                await workbook.xlsx.writeFile(uri.fsPath);
            }
        });

        // Progress is dismissed here — now show the success toast
        const action = await vscode.window.showInformationMessage(
            `Exported ${tableName} successfully.`, 'Open File'
        );
        if (action === 'Open File') {
            vscode.env.openExternal(uri);
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Export failed: ${err.message}`);
    }
}

export async function handleVisualExport(
    cell: vscode.NotebookCell,
    context: vscode.ExtensionContext
): Promise<void> {
    let htmlContent = '';
    for (const output of cell.outputs) {
        for (const item of output.items) {
            if (item.mime === 'application/vnd.vura.visual') {
                htmlContent = new TextDecoder().decode(item.data);
                break;
            }
        }
        if (htmlContent) break;
    }

    if (!htmlContent) {
        vscode.window.showErrorMessage('No visual output found to export.');
        return;
    }

    const formatOptions = ['PNG Image (.png)', 'PDF Document (.pdf)'];
    const format = await vscode.window.showQuickPick(formatOptions, {
        placeHolder: 'Select Export Format'
    });
    if (!format) return;

    const isPdf = format.includes('.pdf');
    const defaultExt = isPdf ? 'pdf' : 'png';
    const filters: { [name: string]: string[] } = {};
    filters[format] = [defaultExt];

    const uri = await vscode.window.showSaveDialog({
        filters,
        defaultUri: vscode.Uri.file(`export_${cell.index}.${defaultExt}`)
    });
    if (!uri) return;

    const storagePath = context.storageUri?.fsPath;
    if (!storagePath) {
        vscode.window.showErrorMessage('Storage context not initialized for exporting.');
        return;
    }

    const browserPath = await resolveBrowserPath();
    if (!browserPath) {
        vscode.window.showErrorMessage('Visual export cancelled — no browser executable was found or selected.');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Exporting Visual to ${defaultExt.toUpperCase()}…`,
            cancellable: false
        }, async () => {
            const isolatedPuppeteer = path.join(storagePath, 'node_modules', 'puppeteer-core');
            if (!fs.existsSync(isolatedPuppeteer)) {
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                spawnSync(npmCmd, ['install', 'puppeteer-core'], { cwd: storagePath });
            }

            const puppeteer = require(path.join(storagePath, 'node_modules', 'puppeteer-core'));

            const browser = await puppeteer.launch({
                executablePath: browserPath || undefined,
                headless: 'new'
            });

            const page = await browser.newPage();
            if (!isPdf) {
                await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
            }
            // For Vega-Lite to render properly in Puppeteer we need to wait for network idle
            await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
            
            // Allow an extra moment for Vega animations/render loops
            await new Promise(r => setTimeout(r, 1000));

            if (isPdf) {
                await page.pdf({
                    path: uri.fsPath,
                    format: 'A4',
                    printBackground: true,
                    margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
                });
            } else {
                await page.screenshot({
                    path: uri.fsPath,
                    fullPage: true,
                    omitBackground: false
                });
            }

            await browser.close();
        });

        const action = await vscode.window.showInformationMessage(
            `Visual exported successfully.`, 'Open File'
        );
        if (action === 'Open File') {
            vscode.env.openExternal(uri);
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Visual export failed: ${err.message}. Make sure Chrome/Edge is installed or configure vura.browserPath.`);
    }
}

