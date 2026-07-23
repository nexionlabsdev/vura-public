import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { NotebookController } from '../notebookController';
import { stringify } from 'csv-stringify/sync';

export async function handleGridCopy(
    tableName: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const format = await vscode.window.showQuickPick(['JSON', 'CSV', 'Markdown Table'], {
        placeHolder: 'Select Copy Format'
    });

    if (!format) return;

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Copying table ${tableName} to clipboard...`,
        cancellable: false
    }, async (progress) => {
        try {
            const { DuckDbManager } = require('../services/duckDbManager');
            const duckDb = await DuckDbManager.getInstance(context);
            let records: any[] = [];
            try {
                records = await duckDb.runQuery(`SELECT * FROM "${tableName}"`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Table ${tableName} not found in local DuckDB.`);
                return;
            }

            if (records.length === 0) {
                vscode.window.showInformationMessage(`Table ${tableName} is empty.`);
                return;
            }

            let textToCopy = '';

            if (format === 'JSON') {
                textToCopy = JSON.stringify(records, null, 2);
            } else if (format === 'CSV') {
                textToCopy = stringify(records, { header: true });
            } else if (format === 'Markdown Table') {
                const keys = Object.keys(records[0]);
                textToCopy = '| ' + keys.join(' | ') + ' |\n';
                textToCopy += '|' + keys.map(() => '---').join('|') + '|\n';
                for (const row of records) {
                    textToCopy += '| ' + keys.map(k => {
                        let val = row[k];
                        if (val === null || val === undefined) return '';
                        if (typeof val === 'object') return JSON.stringify(val);
                        return String(val).replace(/\|/g, '\\|').replace(/\n/g, ' ');
                    }).join(' | ') + ' |\n';
                }
            }

            await vscode.env.clipboard.writeText(textToCopy);
            vscode.window.showInformationMessage(`Successfully copied ${records.length} rows as ${format}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Copy failed: ${err.message}`);
        }
    });
}
