import * as vscode from 'vscode';
import { FlownbCell, RawOutput } from '@vura-data-os/core-sdk';
import { parseFlownbDocument, serializeFlownbDocument } from '@vura-data-os/vura-runner';

export class NotebookSerializer implements vscode.NotebookSerializer {
    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        let doc: { cells: FlownbCell[]; requiredPlugins?: string[] };
        try {
            doc = parseFlownbDocument(new TextDecoder().decode(content));
        } catch {
            doc = { cells: [] };
        }

        const cells = doc.cells.map(item => {
            const cell = new vscode.NotebookCellData(item.kind, item.value, item.language);
            cell.metadata = item.metadata;

            if (item.outputs && item.outputs.length > 0) {
                cell.outputs = item.outputs.map((rawOut: RawOutput) => {
                    const outputItems = rawOut.items.map(rawItem => {
                        const bytes = Buffer.from(rawItem.data, 'base64');
                        return new vscode.NotebookCellOutputItem(bytes, rawItem.mime);
                    });
                    return new vscode.NotebookCellOutput(outputItems);
                });
            }

            return cell;
        });

        const notebookData = new vscode.NotebookData(cells);
        if (doc.requiredPlugins && doc.requiredPlugins.length > 0) {
            notebookData.metadata = { requiredPlugins: doc.requiredPlugins };
        }
        return notebookData;
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        const cells: FlownbCell[] = data.cells.map(cell => ({
            kind: cell.kind === vscode.NotebookCellKind.Code ? 2 : 1,
            language: cell.languageId,
            value: cell.value,
            metadata: cell.metadata
            // Outputs are intentionally not serialized to save space in source control.
        }));

        const requiredPlugins = data.metadata?.requiredPlugins as string[] | undefined;
        return new TextEncoder().encode(serializeFlownbDocument(cells, requiredPlugins));
    }
}
