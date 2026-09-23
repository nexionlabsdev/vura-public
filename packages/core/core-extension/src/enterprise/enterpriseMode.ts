import * as vscode from 'vscode';
import { EnterpriseClient, FetchLike, describeFailure, describePublish, readEnterpriseConfig, workflowFromRegistryPath } from './enterpriseClient';

async function pickNotebook(): Promise<vscode.Uri | undefined> {
    const active = vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'file' && active.fsPath.endsWith('.flownb')) { return active; }
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'VURA notebooks': ['flownb'] } });
    return picked?.[0];
}

/** Registers the enterprise commands. Nothing happens unless `vura.enterprise.apiUrl` is set. */
export function registerEnterpriseMode(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    context.subscriptions.push(vscode.commands.registerCommand('vura.enterprise.publishVersion', async () => {
        const cfg = readEnterpriseConfig(vscode.workspace.getConfiguration('vura').get<string>('enterprise.apiUrl'), process.env);
        if ('problem' in cfg) {
            void vscode.window.showWarningMessage(cfg.problem);
            return;
        }
        const uri = await pickNotebook();
        if (!uri) { return; }
        // Publish what is on disk: an unsaved buffer would silently differ from the published version.
        const dirty = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === uri.toString())?.isDirty;
        if (dirty) {
            void vscode.window.showWarningMessage('Save the notebook first — the published version is the saved file.');
            return;
        }
        const derived = workflowFromRegistryPath(uri.fsPath);
        const base = uri.fsPath.split(/[\\/]/).pop()!.replace(/\.flownb$/, '');
        const name = derived?.name ?? await vscode.window.showInputBox({ prompt: 'Workflow name', value: base, ignoreFocusOut: true });
        if (!name) { return; }
        const folder = derived?.folder ?? (await vscode.window.showInputBox({ prompt: 'Folder (optional)', value: '', ignoreFocusOut: true })) ?? '';
        const flownb = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

        const client = new EnterpriseClient(cfg, (globalThis as any).fetch as FetchLike);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Publishing ${name}…` }, async () => {
            try {
                const r = await client.publish(name, folder, flownb);
                output.appendLine(`[enterprise] ${name}: ${describePublish(r)}`);
                void vscode.window.showInformationMessage(`${name}: ${describePublish(r)}`);
            } catch (e) {
                const msg = describeFailure(e);
                output.appendLine(`[enterprise] publish failed for ${name}: ${msg}`);
                void vscode.window.showErrorMessage(`Publish failed — ${msg}`, { modal: false });
            }
        });
    }));
}
