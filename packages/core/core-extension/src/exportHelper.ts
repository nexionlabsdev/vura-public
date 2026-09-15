import * as vscode from 'vscode';
import * as ExcelJS from 'exceljs';

export class ExportHelper {
    public static async exportToExcel(data: any[]): Promise<void> {
        if (!data || data.length === 0) {
            vscode.window.showErrorMessage('No data to export.');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'Excel Workbook': ['xlsx'] },
            defaultUri: vscode.Uri.file('results.xlsx')
        });

        if (!uri) {
            return;
        }

        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Results');
            
            // Get columns from first row
            const columns = Object.keys(data[0]).map(k => ({ header: k, key: k, width: 20 }));
            worksheet.columns = columns;

            // Add rows
            data.forEach(row => worksheet.addRow(row));

            // Generate buffer and write to the selected path
            const buffer = await workbook.xlsx.writeBuffer();
            await vscode.workspace.fs.writeFile(uri, new Uint8Array(buffer));
            
            vscode.window.showInformationMessage(`Export successful: ${uri.fsPath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Export failed: ${error.message}`);
        }
    }

    public static async exportToCsv(data: any[]): Promise<void> {
        if (!data || data.length === 0) {
            vscode.window.showErrorMessage('No data to export.');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV File': ['csv'] },
            defaultUri: vscode.Uri.file('results.csv')
        });

        if (!uri) {
            return;
        }

        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Results');
            
            const columns = Object.keys(data[0]).map(k => ({ header: k, key: k }));
            worksheet.columns = columns;

            data.forEach(row => worksheet.addRow(row));

            const buffer = await workbook.csv.writeBuffer();
            await vscode.workspace.fs.writeFile(uri, new Uint8Array(buffer));

            vscode.window.showInformationMessage(`Export successful: ${uri.fsPath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Export failed: ${error.message}`);
        }
    }
}
