import * as vscode from 'vscode';
import { ICellLogger } from '@vura-data-os/vura-runner';

export class VsCodeCellLogger implements ICellLogger {
    private streamOutput: vscode.NotebookCellOutput | undefined;

    constructor(private execution: vscode.NotebookCellExecution) {}

    async logText(text: string): Promise<void> {
        if (!this.streamOutput) {
            this.streamOutput = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(text)
            ]);
            await this.execution.appendOutput([this.streamOutput]);
        } else {
            // Need to append text to existing streamOutput, VS Code NotebookCellExecution 
            // appendOutputItems is suitable for appending to the end of the cell outputs, 
            // but for stream text we often just replace the item or create a new one.
            // Let's create a new output for simplicity if we don't track full buffer.
            this.streamOutput = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(text)
            ]);
            await this.execution.appendOutput([this.streamOutput]);
        }
    }

    async logError(error: string | Error): Promise<void> {
        await this.execution.appendOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(error as Error)
        ])]);
    }

    async logHtml(html: string): Promise<void> {
        await this.execution.appendOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'application/vnd.vura.visual')
        ])]);
    }

    async logJson(json: any): Promise<void> {
        await this.execution.appendOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(json, 'application/json')
        ])]);
    }

    async replaceOutput(html: string): Promise<void> {
        await this.execution.replaceOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'application/vnd.vura.visual')
        ])]);
    }

    async logMultiple(items: { mime: string, data: any }[]): Promise<void> {
        const outputItems = items.map(item => {
            if (item.mime === 'application/json') {
                return vscode.NotebookCellOutputItem.json(item.data, item.mime);
            } else if (item.mime === 'application/vnd.vura.visual') {
                return vscode.NotebookCellOutputItem.text(item.data, item.mime);
            } else {
                return vscode.NotebookCellOutputItem.text(String(item.data), item.mime);
            }
        });
        await this.execution.appendOutput([new vscode.NotebookCellOutput(outputItems)]);
    }

    async clearOutput(): Promise<void> {
        await this.execution.clearOutput();
    }
}
