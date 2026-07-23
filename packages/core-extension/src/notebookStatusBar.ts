import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { handleGridExport } from './notebook/exportHandler';
import { handleGraphPdfExport } from './notebook/pdfExportHandler';

const VENV_KEY = 'vura-notebook-pythonVenv';

/** Persistent status bar item that always shows the active venv. */
let _venvStatusBar: vscode.StatusBarItem | undefined;

function updateVenvStatusBar(context: vscode.ExtensionContext) {
    if (!_venvStatusBar) return;
    const venvFolder = context.workspaceState.get<string>(VENV_KEY);
    if (venvFolder) {
        _venvStatusBar.text = `$(python) venv: ${path.basename(venvFolder)}`;
        _venvStatusBar.tooltip = `Python venv: ${venvFolder}\nClick to change`;
        _venvStatusBar.backgroundColor = undefined;
    } else {
        _venvStatusBar.text = `$(python) No venv`;
        _venvStatusBar.tooltip = 'No Python venv selected. Click to configure.';
        _venvStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}


export class NotebookStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
    constructor(private context: vscode.ExtensionContext) {}

    provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.NotebookCellStatusBarItem[] | undefined {
        const items: vscode.NotebookCellStatusBarItem[] = [];

        if (cell.kind === vscode.NotebookCellKind.Code) {
            // API Output Item
            if (cell.metadata?.vura_is_http_output) {
                const httpOutputItem = new vscode.NotebookCellStatusBarItem(
                    `$(globe) API Output`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                httpOutputItem.tooltip = 'This cell is marked as the API HTTP Output. Execution will halt after this cell.';
                items.push(httpOutputItem);
            }

            // Table Name Item
            const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
            const tableNameItem = new vscode.NotebookCellStatusBarItem(
                `$(table) Table: ${tableName}`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            tableNameItem.command = {
                title: 'Set Table Name',
                command: 'vura-notebook.setTableName',
                arguments: [cell]
            };
            tableNameItem.tooltip = 'Click to rename output SQLite table';
            items.push(tableNameItem);

            // SQL Connection Item
            if (cell.document.languageId === 'sql') {
                const connectionName = cell.metadata?.connectionName || 'Context In-Memory (DuckDB)';
                const connectionItem = new vscode.NotebookCellStatusBarItem(
                    `$(database) ${connectionName}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                connectionItem.command = {
                    title: 'Set Connection',
                    command: 'vura-notebook.setConnection',
                    arguments: [cell]
                };
                connectionItem.tooltip = 'Click to select SQL connection';
                items.push(connectionItem);
            }


            // Data Grid Export
            if (cell.outputs.length > 0 && (cell.document.languageId === 'sql' || cell.metadata?.vuraType === 'table' || cell.metadata?.tableName)) {
                const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
                const exportItem = new vscode.NotebookCellStatusBarItem(
                    '$(export) Export Data',
                    vscode.NotebookCellStatusBarAlignment.Left
                );
                exportItem.command = {
                    title: 'Export Data',
                    command: 'vura-notebook.exportData',
                    arguments: [cell]
                };
                items.push(exportItem);
            }


            // File Ingestion
            if (cell.document.languageId === 'vura-terminal') {
                const ingestItem = new vscode.NotebookCellStatusBarItem(
                    '$(file-directory) Ingest Local File',
                    vscode.NotebookCellStatusBarAlignment.Left
                );
                ingestItem.command = {
                    title: 'Ingest Local File',
                    command: 'vura-notebook.ingestFile',
                    arguments: [cell]
                };
                items.push(ingestItem);
            }
            // Python Path Item
            if (cell.document.languageId === 'python') {
                const pythonPath = cell.metadata?.pythonPath || 'Select Python Path';
                const pythonPathItem = new vscode.NotebookCellStatusBarItem(
                    `$(python) ${pythonPath}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                pythonPathItem.command = {
                    title: 'Set Python Path',
                    command: 'vura-notebook.setPythonPath',
                    arguments: [cell]
                };
                pythonPathItem.tooltip = 'Click to select Python executable path';
                items.push(pythonPathItem);
            }

            // HTML Template Context Item
            if (cell.document.languageId === 'html') {
                const ctxTable = cell.metadata?.templateContextTable || 'None';
                const ctxItem = new vscode.NotebookCellStatusBarItem(
                    `$(symbol-variable) Context: ${ctxTable}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                ctxItem.command = {
                    title: 'Set Template Context',
                    command: 'vura-notebook.setTemplateContext',
                    arguments: [cell]
                };
                ctxItem.tooltip = 'Click to select which cell\'s data to use as template context';
                items.push(ctxItem);

                // PDF/PNG Export for template cells with outputs
                if (cell.outputs.length > 0) {
                    const exportItem = new vscode.NotebookCellStatusBarItem(
                        '$(export) Export Visual',
                        vscode.NotebookCellStatusBarAlignment.Left
                    );
                    exportItem.command = {
                        title: 'Export Cell Visual',
                        command: 'vura-notebook.exportCellOutput',
                        arguments: [cell]
                    };
                    exportItem.tooltip = 'Export the rendered template output to a PDF or PNG file';
                    items.push(exportItem);
                }
            }

            // Terminal Cell: Dataverse Connection Picker
            if (cell.document.languageId === 'shellscript') {
                const dataverseConnName = cell.metadata?.dataverseConnectionName || 'Select Dataverse Connection';
                const dataverseConnItem = new vscode.NotebookCellStatusBarItem(
                    `$(cloud) Dataverse: ${dataverseConnName}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                dataverseConnItem.command = {
                    title: 'Set Dataverse Connection',
                    command: 'vura-notebook.setDataverseConnection',
                    arguments: [cell]
                };
                dataverseConnItem.tooltip = 'Click to select which Dataverse connection to use for sync';
                items.push(dataverseConnItem);
            }

            // Vega-Lite cell status bar items
            if (cell.document.languageId === 'vega-lite') {
                // Source Picker
                const sourceLabel = cell.metadata?.graphSourceCellName || 'Select Source';
                const sourceItem = new vscode.NotebookCellStatusBarItem(
                    `$(graph-line) Vega-Lite | Source: ${sourceLabel}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                sourceItem.command = {
                    title: 'Set Graph Source',
                    command: 'vura-notebook.setGraphSource',
                    arguments: [cell]
                };
                sourceItem.tooltip = 'Select which JSON Compose cell provides chart data';
                items.push(sourceItem);

                // Graph Data Path
                const pathLabel = cell.metadata?.graphDataPath || '(root)';
                const pathItem = new vscode.NotebookCellStatusBarItem(
                    `$(key) Data: ${pathLabel}`,
                    vscode.NotebookCellStatusBarAlignment.Right
                );
                pathItem.command = {
                    title: 'Set Data Path',
                    command: 'vura-notebook.setGraphDataPath',
                    arguments: [cell]
                };
                pathItem.tooltip = 'Optional dot-path to a specific key in the JSON (e.g. "orders" or "dashboard.items")';
                items.push(pathItem);

                // PDF/PNG Export for graph cells with output
                if (cell.outputs.length > 0) {
                    const exportItem = new vscode.NotebookCellStatusBarItem(
                        '$(export) Export Visual',
                        vscode.NotebookCellStatusBarAlignment.Left
                    );
                    exportItem.command = {
                        title: 'Export Cell Visual',
                        command: 'vura-notebook.exportCellOutput',
                        arguments: [cell]
                    };
                    exportItem.tooltip = 'Export the rendered Vega-Lite chart to a PDF or PNG file';
                    items.push(exportItem);
                }
            }

            // Flow Control: Group
            const groupName = cell.metadata?.group || 'No group';
            const groupItem = new vscode.NotebookCellStatusBarItem(
                `$(list-tree) Group: ${groupName}`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            groupItem.command = {
                title: 'Set Group',
                command: 'vura-notebook.setGroup',
                arguments: [cell]
            };
            groupItem.tooltip = 'Execution group for this cell.\nIf this cell is a rollback handler, place it in a DIFFERENT group from the cells it monitors.\nClick to set.';
            groupItem.priority = -100;
            items.push(groupItem);

            // Flow Control: Condition (RunWhen)
            const runWhen = cell.metadata?.runWhen as string | undefined;
            const conditionText = runWhen ? `$(zap) ${runWhen.length > 20 ? runWhen.substring(0, 20) + '...' : runWhen}` : `∅ Always`;
            const conditionItem = new vscode.NotebookCellStatusBarItem(
                conditionText,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            conditionItem.command = {
                title: 'Set Run Condition',
                command: 'vura-notebook.setRunWhen',
                arguments: [cell]
            };
            conditionItem.tooltip = runWhen
                ? `Condition: ${runWhen}\n⚠ Only evaluated during Run All — single-cell execution ignores this condition`
                : 'Click to set execution condition (RunWhen)\n⚠ Only evaluated during Run All';
            conditionItem.priority = -101;
            items.push(conditionItem);

            // Flow Control: Label
            const labelName = cell.metadata?.label;
            const labelItem = new vscode.NotebookCellStatusBarItem(
                labelName ? `$(tag) Label: ${labelName}` : `$(tag) Set Label`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            labelItem.command = {
                title: 'Set Label',
                command: 'vura-notebook.setLabel',
                arguments: [cell]
            };
            labelItem.tooltip = 'Click to set the cell execution label';
            labelItem.priority = -102;
            items.push(labelItem);
        }

        return items;
    }
}

export function registerNotebookStatusBarCommands(context: vscode.ExtensionContext) {
    // --- Venv status bar item (always visible when a notebook is open) ---
    _venvStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    _venvStatusBar.command = 'vura-notebook.selectVenv';
    context.subscriptions.push(_venvStatusBar);
    updateVenvStatusBar(context);
    _venvStatusBar.show();

    _venvStatusBar.show();

    // --- Flow Control Commands ---
    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setGroup', async (cell: vscode.NotebookCell) => {
        const groups = new Set<string>();
        for (const c of cell.notebook.getCells()) {
            if (c.metadata?.group) groups.add(c.metadata.group);
        }
        
        const items: vscode.QuickPickItem[] = Array.from(groups).map(g => ({ label: g }));
        items.unshift({ label: 'Add new group...' });
        items.push({ label: 'Clear group (None)' });
        
        const pick = await vscode.window.showQuickPick(items, { title: 'Select Execution Group' });
        if (!pick) return;
        
        let newGroup: string | undefined = pick.label;
        if (pick.label === 'Add new group...') {
            newGroup = await vscode.window.showInputBox({ title: 'New Group Name' });
            if (!newGroup) return;
        } else if (pick.label === 'Clear group (None)') {
            newGroup = undefined;
        }
        
        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...cell.metadata, group: newGroup };
        if (!newGroup) delete newMetadata.group;
        const cellEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [cellEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setLabel', async (cell: vscode.NotebookCell) => {
        const currentLabel = cell.metadata?.label || '';
        const newLabel = await vscode.window.showInputBox({
            title: 'Cell Label',
            prompt: 'Enter alphanumeric label (underscores allowed)',
            value: currentLabel,
            validateInput: (val) => {
                if (val && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) return 'Invalid label format. Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/';
                return null;
            }
        });
        if (newLabel === undefined) return;
        
        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...cell.metadata, label: newLabel === '' ? undefined : newLabel };
        if (newLabel === '') delete newMetadata.label;
        const cellEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [cellEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setRunWhen', async (cell: vscode.NotebookCell) => {
        const step1Items: vscode.QuickPickItem[] = [
            { label: 'Previous cell status', description: "cell_N.status == 'error'" },
            { label: 'Specific cell/group status', description: 'Prompts for label/group name' },
            { label: 'Cell returned no data', description: "cell_N.rowCount == 0" },
            { label: 'Custom expression', description: 'Free-form expr-eval string' },
            { label: 'Clear condition (Always run)' }
        ];
        const typePick = await vscode.window.showQuickPick(step1Items, { title: 'Select Condition Type' });
        if (!typePick) return;

        let condition: string | undefined = undefined;

        if (typePick.label === 'Clear condition (Always run)') {
            condition = undefined;
        } else if (typePick.label === 'Custom expression') {
            condition = await vscode.window.showInputBox({ title: 'Enter runWhen expression', value: cell.metadata?.runWhen || '' });
            if (condition === undefined) return;
        } else if (typePick.label === 'Previous cell status') {
            const statusChoice = await vscode.window.showQuickPick(['success', 'error', 'skipped'], { title: 'Run when previous cell is:' });
            if (!statusChoice) return;
            const targetCellIndex = cell.index; // previous cell is cell.index. And it's 1-based, so cell_${cell.index} refers to the previous cell since cell.index is the 0-based index of the *current* cell, which means its 1-based index is cell.index + 1. The previous cell is cell.index.
            condition = `cell_${targetCellIndex}.status == '${statusChoice}'`;
        } else if (typePick.label === 'Specific cell/group status') {
            const target = await vscode.window.showInputBox({ title: 'Enter cell label or "group.group_name"' });
            if (!target) return;
            const statusChoice = await vscode.window.showQuickPick(['success', 'error', 'partial', 'skipped'], { title: 'Status' });
            if (!statusChoice) return;
            condition = `${target}.status == '${statusChoice}'`;
            // Rollback pattern: firing on group failure means this cell is a rollback handler.
            // Rollback cells must be in a DIFFERENT group from the cells they monitor or they'll be aborted too.
            if ((statusChoice === 'error' || statusChoice === 'partial') && target.startsWith('group.')) {
                vscode.window.showInformationMessage(
                    'Rollback pattern detected: make sure this cell is in a DIFFERENT group than the cells it handles. ' +
                    'If it shares the same group, it will be aborted when that group fails.'
                );
            }
        } else if (typePick.label === 'Cell returned no data') {
            const target = await vscode.window.showInputBox({ title: 'Enter cell label or cell_N', value: `cell_${cell.index}` });
            if (!target) return;
            condition = `${target}.rowCount == 0`;
        }

        if (condition !== undefined) {
            // Show preview
            const confirm = await vscode.window.showQuickPick(['Confirm', 'Cancel'], { title: `Set runWhen to: ${condition}` });
            if (confirm !== 'Confirm') return;
        }

        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...cell.metadata, runWhen: condition };
        if (condition === undefined) delete newMetadata.runWhen;
        const cellEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [cellEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    // --- Select / Create Venv command ---
    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.selectVenv', async () => {
        const current = context.workspaceState.get<string>(VENV_KEY);
        const isWin = process.platform === 'win32';

        const items: vscode.QuickPickItem[] = [
            {
                label: '$(folder-opened) Select existing venv folder',
                description: 'Point to an already-created Python virtual environment'
            },
            {
                label: '$(add) Create new venv',
                description: 'Choose a location — Vura will run python -m venv for you'
            }
        ];

        if (current) {
            items.unshift({
                label: `$(check) Current: ${path.basename(current)}`,
                description: current,
                detail: 'Currently active venv — pick an option below to change it'
            });
        }

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: current
                ? `Active venv: ${path.basename(current)} — choose an action`
                : 'No venv configured — select or create one',
            title: 'Python Virtual Environment'
        });

        if (!pick) return;

        if (pick.label.includes('Select existing')) {
            // --- Browse for existing venv ---
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select venv folder'
            });
            if (!uris || uris.length === 0) return;
            const selected = uris[0].fsPath;

            // Validate it looks like a real venv
            const pythonBin = isWin
                ? path.join(selected, 'Scripts', 'python.exe')
                : path.join(selected, 'bin', 'python');
            const { promises: fs } = require('fs');
            try {
                await fs.access(pythonBin);
            } catch {
                const anyway = await vscode.window.showWarningMessage(
                    `"${path.basename(selected)}" doesn't look like a valid venv (python binary not found). Use it anyway?`,
                    'Yes', 'Cancel'
                );
                if (anyway !== 'Yes') return;
            }

            await context.workspaceState.update(VENV_KEY, selected);
            updateVenvStatusBar(context);
            vscode.window.showInformationMessage(`Python venv set to: ${path.basename(selected)}`);

        } else if (pick.label.includes('Create new')) {
            // --- Pick a parent folder, then a name ---
            const parentUris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Choose where to create the venv'
            });
            if (!parentUris || parentUris.length === 0) return;

            const venvName = await vscode.window.showInputBox({
                prompt: 'Name for the new virtual environment folder',
                value: '.venv',
                validateInput: v => v.trim() ? undefined : 'Name cannot be empty'
            });
            if (!venvName) return;

            const venvPath = path.join(parentUris[0].fsPath, venvName);

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Creating Python venv at ${venvPath}…`,
                cancellable: false
            }, async () => {
                const { spawn } = require('child_process');
                await new Promise<void>((resolve, reject) => {
                    const py = isWin ? 'python' : 'python3';
                    const proc = spawn(py, ['-m', 'venv', venvPath], {
                        env: process.env,
                        cwd: parentUris[0].fsPath
                    });
                    proc.on('close', (code: number) => code === 0 ? resolve() : reject(new Error(`python -m venv exited with code ${code}`)));
                });
            });

            await context.workspaceState.update(VENV_KEY, venvPath);
            // Reset deps-installed flag so baseline packages get installed on next run
            await context.workspaceState.update(`vura-python-deps-${venvPath}`, undefined);
            updateVenvStatusBar(context);
            vscode.window.showInformationMessage(`Created and activated venv: ${venvName}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setTableName', async (cell: vscode.NotebookCell) => {
        const defaultName = cell.metadata?.tableName || `cell_${cell.index}`;
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter table name for this cell',
            value: defaultName
        });
        if (newName) {
            const edit = new vscode.WorkspaceEdit();
            const newMetadata = { ...(cell.metadata || {}), tableName: newName };
            const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
            edit.set(cell.notebook.uri, [notebookEdit]);
            await vscode.workspace.applyEdit(edit);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setConnection', async (cell: vscode.NotebookCell) => {
        const profiles = ConnectionManager.getProfiles(context);
        const localOption = { label: 'Context In-Memory (DuckDB)', description: 'Local memory', id: 'local' };

        const items = [localOption, ...profiles.map(p => ({ label: p.name, description: p.authMode, id: p.id }))];
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select SQL Connection' });

        if (selected) {
            const edit = new vscode.WorkspaceEdit();
            const newMetadata = { ...(cell.metadata || {}), connectionName: selected.label, connectionId: selected.id };
            const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
            edit.set(cell.notebook.uri, [notebookEdit]);
            await vscode.workspace.applyEdit(edit);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setPythonPath', async (cell: vscode.NotebookCell) => {
        const currentPath = cell.metadata?.pythonPath;
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Select Python Executable',
            defaultUri: currentPath ? vscode.Uri.file(currentPath) : undefined
        });

        if (uris && uris.length > 0) {
            const selectedPath = uris[0].fsPath;
            const edit = new vscode.WorkspaceEdit();
            const newMetadata = { ...(cell.metadata || {}), pythonPath: selectedPath };
            const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
            edit.set(cell.notebook.uri, [notebookEdit]);
            await vscode.workspace.applyEdit(edit);

            // Also update workspace default
            context.workspaceState.update('vura-notebook-pythonPath', selectedPath);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.exportData', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath;
        if (!storagePath) return;
        const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
        await handleGridExport(tableName, context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.exportGraphPdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath;
        if (!storagePath) return;

        let htmlContent = '';
        for (const output of cell.outputs) {
            for (const item of output.items) {
                if (item.mime === 'application/vnd.vura.visual') {
                    htmlContent = new TextDecoder().decode(item.data);
                    break;
                }
            }
        }

        if (!htmlContent) {
            vscode.window.showErrorMessage("Could not find HTML representation of the graph.");
            return;
        }

        await handleGraphPdfExport(htmlContent, storagePath, context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.configureOData', async (cell: vscode.NotebookCell) => {
        const operation = await vscode.window.showQuickPick(['insert', 'update', 'delete'], {
            placeHolder: 'Select OData Operation'
        });
        if (!operation) return;

        // Fetch entities for QuickPick
        const connectionId = cell.metadata?.connectionId;
        if (!connectionId || connectionId === 'local') {
            vscode.window.showErrorMessage('Select an active Dataverse Connection Profile in the cell status bar first.');
            return;
        }

        const activeProfile = ConnectionManager.getProfiles(context).find(p => p.id === connectionId);
        if (!activeProfile) return;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching Dataverse Entities...',
            cancellable: false
        }, async () => {
            try {
                const secretPayload = await ConnectionManager.getSecretForProfile(context, activeProfile.id);
                const msal = require('@azure/msal-node');
                const cca = new msal.ConfidentialClientApplication({
                    auth: {
                        clientId: activeProfile.clientId,
                        authority: `https://login.microsoftonline.com/${activeProfile.tenantId}`,
                        clientSecret: secretPayload
                    }
                });
                const response = await cca.acquireTokenByClientCredential({
                    scopes: [`https://${activeProfile.server}/.default`]
                });
                const token = response.accessToken;

                const url = `https://${activeProfile.server}/api/data/v9.2/EntityDefinitions?$select=LogicalName`;
                const res = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });

                if (!res.ok) throw new Error("Failed to fetch entities");
                const data = await res.json();

                const entities = data.value.map((e: any) => e.LogicalName).sort();

                const targetEntity = await vscode.window.showQuickPick(entities, {
                    placeHolder: 'Select Target Entity'
                });

                if (!targetEntity) return;

                const tableName = cell.metadata?.tableName || `cell_${cell.index}`;

                const magicCommand = `-- !odata-push ${operation} ${tableName} -> ${targetEntity}\n`;

                const edit = new vscode.WorkspaceEdit();
                edit.insert(cell.document.uri, new vscode.Position(0, 0), magicCommand);
                await vscode.workspace.applyEdit(edit);

            } catch (err: any) {
                vscode.window.showErrorMessage('Error: ' + err.message);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.ingestFile', async (cell: vscode.NotebookCell) => {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Data Files': ['csv', 'xlsx', 'parquet', 'json'] },
            openLabel: 'Select File to Ingest'
        });

        if (!uri || uri.length === 0) return;

        const filePath = uri[0].fsPath;
        const notebookDir = require('path').dirname(cell.notebook.uri.fsPath);
        const relativePath = require('path').relative(notebookDir, filePath);

        const ext = require('path').extname(filePath).toLowerCase();
        let fileType = 'csv';
        if (ext === '.xlsx' || ext === '.xls') fileType = 'excel';
        else if (ext === '.parquet') fileType = 'parquet';
        else if (ext === '.json') fileType = 'json';

        let sheetName = '';
        if (fileType === 'excel') {
            sheetName = await vscode.window.showInputBox({ prompt: 'Enter Sheet Name (leave empty to import all sheets)' }) || '';
        }

        const tableName = await vscode.window.showInputBox({
            prompt: 'Enter target table name (prefix)',
            value: require('path').basename(filePath, ext).replace(/[^a-zA-Z0-9]/g, '_')
        });

        if (!tableName) return;

        let magicCommand = `!ingest-file "${relativePath}" ${fileType}`;
        if (sheetName) {
            magicCommand += ` "${sheetName}"`;
        }
        magicCommand += ` -> ${tableName}\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(cell.document.uri, new vscode.Position(0, 0), magicCommand);
        await vscode.workspace.applyEdit(edit);
    }));

    // --- HTML Template Cell Commands ---

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setTemplateContext', async (cell: vscode.NotebookCell) => {
        // Collect table names from all prior cells in the same notebook
        const notebook = cell.notebook;
        const pickItems: vscode.QuickPickItem[] = [{ label: 'None', description: 'No data context (static HTML)' }];

        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            if (c.index >= cell.index) break; // Only prior cells
            const tbl = c.metadata?.tableName || `cell_${c.index}`;
            const lang = c.document.languageId;
            pickItems.push({
                label: tbl,
                description: `Cell ${c.index + 1} (${lang})`
            });
        }

        const selected = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Select which cell\'s output data to use as template context'
        });

        if (!selected) return;

        const edit = new vscode.WorkspaceEdit();
        const contextValue = selected.label === 'None' ? undefined : selected.label;
        const newMetadata = { ...(cell.metadata || {}), templateContextTable: contextValue };
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.exportTemplatePdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath;
        if (!storagePath) return;

        let htmlContent = '';
        for (const output of cell.outputs) {
            for (const item of output.items) {
                if (item.mime === 'application/vnd.vura.visual') {
                    htmlContent = new TextDecoder().decode(item.data);
                    break;
                }
            }
        }

        if (!htmlContent) {
            vscode.window.showErrorMessage('No rendered HTML output found. Execute the template cell first.');
            return;
        }

        await handleGraphPdfExport(htmlContent, storagePath, context);
    }));

    // --- Terminal Cell Commands ---

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setDataverseConnection', async (cell: vscode.NotebookCell) => {
        const profiles = ConnectionManager.getProfiles(context);
        // Filter to profiles that support OData (ServicePrincipal)
        const dataverseProfiles = profiles.filter(p => p.authMode === 'ServicePrincipal');

        if (dataverseProfiles.length === 0) {
            vscode.window.showErrorMessage(
                'No Dataverse connection profiles found. Create a Service Principal profile in the Connection Configuration sidebar.'
            );
            return;
        }

        const items = dataverseProfiles.map(p => ({
            label: p.name,
            description: `${p.server} (${p.authMode})`,
            id: p.id
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Dataverse Connection for Sync'
        });

        if (selected) {
            const edit = new vscode.WorkspaceEdit();
            const newMetadata = {
                ...(cell.metadata || {}),
                dataverseConnectionName: selected.label,
                dataverseConnectionId: selected.id
            };
            const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
            edit.set(cell.notebook.uri, [notebookEdit]);
            await vscode.workspace.applyEdit(edit);
        }
    }));

    // --- JSON / Graph Cell Commands ---


    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setGraphSource', async (cell: vscode.NotebookCell) => {
        const notebook = cell.notebook;
        const pickItems: vscode.QuickPickItem[] = [];

        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            if (c.index >= cell.index) break; // Only prior cells
            // Only show JSON compose cells (json language without vega-graph vuraType)
            if (c.document.languageId === 'json') {
                const tbl = c.metadata?.tableName || `cell_${c.index}`;
                pickItems.push({
                    label: tbl,
                    description: `Cell ${c.index + 1} (JSON Compose)`
                });
            }
        }

        if (pickItems.length === 0) {
            vscode.window.showWarningMessage('No JSON Compose cells found before this cell. Create one first.');
            return;
        }

        const selected = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Select JSON Compose cell as data source for this graph'
        });

        if (!selected) return;

        // Find the source cell index
        let sourceCellIndex = -1;
        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            const tbl = c.metadata?.tableName || `cell_${c.index}`;
            if (tbl === selected.label && c.document.languageId === 'json') {
                sourceCellIndex = c.index;
                break;
            }
        }

        const edit = new vscode.WorkspaceEdit();
        const newMetadata = {
            ...(cell.metadata || {}),
            graphSourceCell: sourceCellIndex,
            graphSourceCellName: selected.label
        };
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.setGraphDataPath', async (cell: vscode.NotebookCell) => {
        const currentPath = cell.metadata?.graphDataPath || '';
        const newPath = await vscode.window.showInputBox({
            prompt: 'Enter dot-path to data key in the JSON (e.g. "orders" or "dashboard.items"). Leave empty for root.',
            value: currentPath,
            placeHolder: 'e.g. orders'
        });

        if (newPath === undefined) return; // Cancelled

        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...(cell.metadata || {}), graphDataPath: newPath || undefined };
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vura-notebook.exportVegaGraphPdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath;
        if (!storagePath) return;

        let htmlContent = '';
        for (const output of cell.outputs) {
            for (const item of output.items) {
                if (item.mime === 'application/vnd.vura.visual') {
                    htmlContent = new TextDecoder().decode(item.data);
                    break;
                }
            }
        }

        if (!htmlContent) {
            vscode.window.showErrorMessage('No rendered HTML output found. Execute the Vega-Lite cell first.');
            return;
        }

        await handleGraphPdfExport(htmlContent, storagePath, context);
    }));

}
