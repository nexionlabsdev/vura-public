import * as vscode from 'vscode';
import * as fs from 'fs';

interface StoredOutputItem {
    mime: string;
    data: string; // base64 string
}

interface StoredCellOutput {
    index: number;
    outputs: StoredOutputItem[][];
}

export async function saveNotebookOutputs(document: vscode.NotebookDocument): Promise<void> {
    if (document.notebookType !== 'vura-notebook') return;

    const sidecarUri = vscode.Uri.file(document.uri.fsPath + '.outputs.json');
    const storedCells: StoredCellOutput[] = [];

    for (const cell of document.getCells()) {
        if (cell.outputs && cell.outputs.length > 0) {
            const outputs: StoredOutputItem[][] = [];
            for (const out of cell.outputs) {
                const items: StoredOutputItem[] = [];
                for (const item of out.items) {
                    items.push({
                        mime: item.mime,
                        data: Buffer.from(item.data).toString('base64')
                    });
                }
                outputs.push(items);
            }
            storedCells.push({
                index: cell.index,
                outputs
            });
        }
    }

    // Always write the sidecar file (even if empty, to clear out old outputs)
    try {
        await vscode.workspace.fs.writeFile(
            sidecarUri,
            new TextEncoder().encode(JSON.stringify(storedCells, null, 2))
        );
    } catch (err) {
        console.error(`Failed to save notebook outputs for ${document.uri.fsPath}`, err);
    }
}

export async function restoreNotebookOutputs(document: vscode.NotebookDocument): Promise<void> {
    if (document.notebookType !== 'vura-notebook') return;

    const sidecarUri = vscode.Uri.file(document.uri.fsPath + '.outputs.json');
    
    let content: Uint8Array;
    try {
        content = await vscode.workspace.fs.readFile(sidecarUri);
    } catch (err) {
        // File doesn't exist or can't be read, which is fine
        return;
    }

    try {
        const storedCells: StoredCellOutput[] = JSON.parse(new TextDecoder().decode(content));
        if (!Array.isArray(storedCells) || storedCells.length === 0) return;

        const edit = new vscode.WorkspaceEdit();
        let hasChanges = false;

        for (const storedCell of storedCells) {
            if (storedCell.index < document.cellCount) {
                const cellOutputs = storedCell.outputs.map(outArray => {
                    const items = outArray.map(item => {
                        return new vscode.NotebookCellOutputItem(
                            Buffer.from(item.data, 'base64'),
                            item.mime
                        );
                    });
                    return new vscode.NotebookCellOutput(items);
                });
                const oldCell = document.cellAt(storedCell.index);
                const newCell = new vscode.NotebookCellData(oldCell.kind, oldCell.document.getText(), oldCell.document.languageId);
                newCell.outputs = cellOutputs;
                newCell.metadata = oldCell.metadata;
                newCell.executionSummary = oldCell.executionSummary;

                edit.set(document.uri, [
                    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(storedCell.index, storedCell.index + 1), [newCell])
                ]);
                hasChanges = true;
            }
        }

        if (hasChanges) {
            await vscode.workspace.applyEdit(edit);
            // Immediately save the document to clear the dirty flag triggered by restoring outputs
            await document.save();
        }
    } catch (err) {
        console.error(`Failed to restore notebook outputs for ${document.uri.fsPath}`, err);
    }
}
