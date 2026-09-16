import * as vscode from 'vscode';
import { ICellLogger } from '@vura-data-os/vura-runner';

export class OutputChannelLogger implements ICellLogger {
    constructor(private channel: vscode.OutputChannel) {}

    async logText(text: string): Promise<void> {
        this.channel.appendLine(text);
    }

    async logError(error: string | Error): Promise<void> {
        this.channel.appendLine(typeof error === 'string' ? error : error.message);
    }

    async logHtml(html: string): Promise<void> {
        this.channel.appendLine("[HTML Output omitted]");
    }

    async logJson(json: any): Promise<void> {
        this.channel.appendLine(JSON.stringify(json, null, 2));
    }

    async replaceOutput(html: string): Promise<void> {
        this.channel.appendLine("[HTML Output omitted]");
    }

    async logMultiple(items: { mime: string, data: any }[]): Promise<void> {
        for (const item of items) {
            if (item.mime === 'application/json') {
                this.channel.appendLine(JSON.stringify(item.data, null, 2));
            } else if (item.mime === 'application/vnd.vura.visual') {
                this.channel.appendLine("[HTML Output omitted]");
            } else {
                this.channel.appendLine(`[${item.mime} Output omitted]`);
            }
        }
    }

    async clearOutput(): Promise<void> {
        // Output channels don't typically clear per cell
    }
}
