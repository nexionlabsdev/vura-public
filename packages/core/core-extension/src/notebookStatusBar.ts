import * as vscode from 'vscode';
import * as path from 'path';
import { ProviderRegistry, FlownbCell, UIAction } from '@vura-data-os/core-sdk';
import { ConnectionManager } from './connectionManager';
import { VsCodeEnvironment } from './VsCodeEnvironment';
import { KIND_DISPLAY_NAMES } from './connectionsConfigViewProvider';
import { handleGridExport } from './notebook/exportHandler';
import { handleGraphPdfExport } from './notebook/pdfExportHandler';
import { safeRegisterCommand } from './commandUtils';

const VENV_KEY = 'vura-notebook-pythonVenv';

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

            // File Ingestion & File Export
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

                const exportItem = new vscode.NotebookCellStatusBarItem(
                    '$(export) Export File',
                    vscode.NotebookCellStatusBarAlignment.Left
                );
                exportItem.command = {
                    title: 'Export File',
                    command: 'vura-notebook.exportFileCommand',
                    arguments: [cell]
                };
                items.push(exportItem);
            }

            // Dynamic UI Actions from registered IUIActionProviders
            if (cell.document.languageId === 'vura-terminal' || cell.document.languageId === 'shellscript') {
                const flownbCell: FlownbCell = {
                    kind: cell.kind,
                    language: cell.document.languageId,
                    value: cell.document.getText(),
                    metadata: cell.metadata ? { ...cell.metadata } : {}
                };

                const providers = ProviderRegistry.getInstance().getAllProviders();
                for (const provider of providers) {
                    if (typeof (provider as any).getUIActions === 'function') {
                        const actions: UIAction[] = (provider as any).getUIActions(flownbCell);
                        for (const action of actions) {
                            const item = new vscode.NotebookCellStatusBarItem(
                                action.label,
                                vscode.NotebookCellStatusBarAlignment.Right
                            );
                            item.command = {
                                title: action.label,
                                command: 'vura-notebook.executeUIAction',
                                arguments: [action, cell]
                            };
                            item.tooltip = `Click to execute ${action.label}`;
                            items.push(item);
                        }
                    }
                }
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

            // Single connection picker for shellscript/terminal cells — one status bar
            // item regardless of how many connector kinds are registered (Dataverse,
            // SharePoint, OneDrive, Google Drive, S3, local folder, ...). Clicking it
            // opens a two-step popup (kind, then connection) instead of cluttering the
            // cell toolbar with one button per kind.
            if (cell.document.languageId === 'shellscript' || cell.document.languageId === 'vura-terminal') {
                const kindsWithProvider = ProviderRegistry.getInstance().getAllProviders()
                    .map(p => p.getConnectorKind?.())
                    .filter((k): k is string => !!k);

                if (kindsWithProvider.length > 0) {
                    const configuredCount = kindsWithProvider.filter(kind => cell.metadata?.[`${kind}ConnectionId`]).length;
                    const connItem = new vscode.NotebookCellStatusBarItem(
                        `$(plug) Connections${configuredCount > 0 ? ` (${configuredCount})` : ''}`,
                        vscode.NotebookCellStatusBarAlignment.Right
                    );
                    connItem.command = {
                        title: 'Configure Connections',
                        command: 'vura-notebook.configureConnections',
                        arguments: [cell]
                    };
                    connItem.tooltip = 'Configure which connections this cell uses';
                    items.push(connItem);
                }
            }

            // Vega-Lite cell status bar items
            if (cell.document.languageId === 'vega-lite') {
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
    _venvStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    _venvStatusBar.command = 'vura-notebook.selectVenv';
    context.subscriptions.push(_venvStatusBar);
    updateVenvStatusBar(context);
    _venvStatusBar.show();

    // --- Dynamic SDK UI Action execution command ---
    context.subscriptions.push(safeRegisterCommand('vura-notebook.executeUIAction', async (action: UIAction, cell: vscode.NotebookCell) => {
        const flownbCell: FlownbCell = {
            kind: cell.kind,
            language: cell.document.languageId,
            value: cell.document.getText(),
            metadata: cell.metadata ? { ...cell.metadata } : {}
        };

        let selectedValue: string | undefined = '';

        if (action.kind === 'quickpick' && action.options) {
            const options = await action.options();
            selectedValue = await vscode.window.showQuickPick(options, { placeHolder: action.label });
            if (selectedValue === undefined) return;
        } else if (action.kind === 'input') {
            selectedValue = await vscode.window.showInputBox({ prompt: action.label });
            if (selectedValue === undefined) return;
        }

        await action.onSelect(selectedValue || '', flownbCell);

        if (flownbCell.value !== cell.document.getText()) {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(0, 0, cell.document.lineCount, cell.document.lineAt(cell.document.lineCount - 1).text.length);
            edit.replace(cell.document.uri, fullRange, flownbCell.value);
            await vscode.workspace.applyEdit(edit);
        }
    }));

    // --- Flow Control Commands ---
    context.subscriptions.push(safeRegisterCommand('vura-notebook.setGroup', async (cell: vscode.NotebookCell) => {
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setLabel', async (cell: vscode.NotebookCell) => {
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setRunWhen', async (cell: vscode.NotebookCell) => {
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
            const targetCellIndex = cell.index;
            condition = `cell_${targetCellIndex}.status == '${statusChoice}'`;
        } else if (typePick.label === 'Specific cell/group status') {
            const target = await vscode.window.showInputBox({ title: 'Enter cell label or "group.group_name"' });
            if (!target) return;
            const statusChoice = await vscode.window.showQuickPick(['success', 'error', 'partial', 'skipped'], { title: 'Status' });
            if (!statusChoice) return;
            condition = `${target}.status == '${statusChoice}'`;
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
    context.subscriptions.push(safeRegisterCommand('vura-notebook.selectVenv', async () => {
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
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select venv folder'
            });
            if (!uris || uris.length === 0) return;
            const selected = uris[0].fsPath;

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
            await context.workspaceState.update(`vura-python-deps-${venvPath}`, undefined);
            updateVenvStatusBar(context);
            vscode.window.showInformationMessage(`Created and activated venv: ${venvName}`);
        }
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setTableName', async (cell: vscode.NotebookCell) => {
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setConnection', async (cell: vscode.NotebookCell) => {
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setPythonPath', async (cell: vscode.NotebookCell) => {
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

            context.workspaceState.update('vura-notebook-pythonPath', selectedPath);
        }
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.exportData', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath;
        if (!storagePath) return;
        const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
        await handleGridExport(tableName, new VsCodeEnvironment(context, cell));
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.exportGraphPdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath || context.globalStorageUri?.fsPath || require('os').tmpdir();
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.configureOData', async (cell: vscode.NotebookCell) => {
        const operation = await vscode.window.showQuickPick(['insert', 'update', 'delete'], {
            placeHolder: 'Select OData Operation'
        });
        if (!operation) return;

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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.ingestFile', async (cell: vscode.NotebookCell) => {
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.exportFileCommand', async (cell: vscode.NotebookCell) => {
        const notebook = cell.notebook;
        const knownTables = new Set<string>();
        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            const tbl = c.metadata?.tableName || `cell_${c.index}`;
            knownTables.add(tbl);
        }

        const pickItems: vscode.QuickPickItem[] = Array.from(knownTables).map(t => ({ label: t, description: 'Table from notebook cell' }));
        pickItems.unshift({ label: '$(edit) Enter custom table name...', description: 'Specify a table name manually' });

        const selectedSource = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Select Source Table to Export'
        });

        if (!selectedSource) return;

        let sourceTable = selectedSource.label;
        if (selectedSource.label.includes('Enter custom table name')) {
            const customName = await vscode.window.showInputBox({
                prompt: 'Enter source table name'
            });
            if (!customName) return;
            sourceTable = customName.trim();
        }

        const formatOptions = ['xlsx', 'csv', 'json', 'parquet'];
        const selectedFormat = await vscode.window.showQuickPick(formatOptions, {
            placeHolder: 'Select Export Format'
        });

        if (!selectedFormat) return;

        const defaultTargetName = `${sourceTable.replace(/[^a-zA-Z0-9_]/g, '_')}_export`;
        const outputTable = await vscode.window.showInputBox({
            prompt: 'Enter target output table name',
            value: defaultTargetName
        });

        if (!outputTable) return;

        const srcParam = sourceTable.includes(' ') ? `"${sourceTable}"` : sourceTable;
        const outParam = outputTable.includes(' ') ? `"${outputTable}"` : outputTable;

        const magicCommand = `!export-file ${srcParam} ${selectedFormat} -> ${outParam}\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(cell.document.uri, new vscode.Position(0, 0), magicCommand);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setTemplateContext', async (cell: vscode.NotebookCell) => {
        const notebook = cell.notebook;
        const pickItems: vscode.QuickPickItem[] = [{ label: 'None', description: 'No data context (static HTML)' }];

        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            if (c.index >= cell.index) break;
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

    context.subscriptions.push(safeRegisterCommand('vura-notebook.exportTemplatePdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath || context.globalStorageUri?.fsPath || require('os').tmpdir();
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

    // Generic connection picker, used by every connector Add-on that declares a
    // connector kind (getConnectorKind()). Lists that kind's ConnectionManager
    // profiles and writes `${kind}ConnectionName`/`${kind}ConnectionId` onto the
    // cell's metadata — the same key pattern vura-dataverse already used for
    // `dataverseConnectionId`, so existing sync handlers keep working unmodified.
    async function pickAndApplyConnection(cell: vscode.NotebookCell, kind: string): Promise<void> {
        const profiles = ConnectionManager.getAllConnectionProfiles(context, kind);

        if (profiles.length === 0) {
            vscode.window.showErrorMessage(
                `No ${kind} connection profiles found. Add one in the Connections sidebar (or via the CLI's "connections add" command).`
            );
            return;
        }

        const currentId = cell.metadata?.[`${kind}ConnectionId`];
        const items = [
            { label: '$(circle-slash) None', description: 'Clear this connection', id: null as string | null },
            ...profiles.map(p => ({
                label: (p.id === currentId ? '$(check) ' : '') + p.name,
                description: p.kind === 'sql' ? `${p.config.server} (${p.config.authMode})` : p.kind,
                id: p.id as string | null
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select ${KIND_DISPLAY_NAMES[kind] || kind} Connection`
        });
        if (!selected) return;

        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...(cell.metadata || {}) };
        if (selected.id === null) {
            delete newMetadata[`${kind}ConnectionId`];
            delete newMetadata[`${kind}ConnectionName`];
        } else {
            newMetadata[`${kind}ConnectionId`] = selected.id;
            newMetadata[`${kind}ConnectionName`] = selected.label.replace('$(check) ', '');
        }
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setProviderConnection', async (cell: vscode.NotebookCell, kind: string) => {
        await pickAndApplyConnection(cell, kind);
    }));

    // Thin wrapper kept for the existing 'vura-notebook.setDataverseConnection'
    // command id (declared in package.json / invoked by older notebooks) — no
    // behavior change for users who already rely on it.
    context.subscriptions.push(safeRegisterCommand('vura-notebook.setDataverseConnection', async (cell: vscode.NotebookCell) => {
        await pickAndApplyConnection(cell, 'dataverse');
    }));

    // Single entry point for a cell's connections: one status bar button opens
    // this, rather than one button per registered connector kind (which used to
    // clutter — and at narrow widths, overflow off — the cell toolbar).
    context.subscriptions.push(safeRegisterCommand('vura-notebook.configureConnections', async (cell: vscode.NotebookCell) => {
        const kinds = ProviderRegistry.getInstance().getAllProviders()
            .map(p => p.getConnectorKind?.())
            .filter((k): k is string => !!k);

        if (kinds.length === 0) {
            vscode.window.showInformationMessage('No connector Add-ons are registered (SharePoint, OneDrive, Google Drive, S3, local folder, Dataverse, ...).');
            return;
        }

        if (kinds.length === 1) {
            await pickAndApplyConnection(cell, kinds[0]);
            return;
        }

        const kindItems = kinds.map(connectorKind => {
            const currentName = cell.metadata?.[`${connectorKind}ConnectionName`];
            return {
                label: `$(plug) ${KIND_DISPLAY_NAMES[connectorKind] || connectorKind}`,
                description: currentName ? `Connected: ${currentName}` : 'Not configured',
                connectorKind
            };
        });

        const selectedKind = await vscode.window.showQuickPick(kindItems, { placeHolder: 'Configure a connection for this cell' });
        if (!selectedKind) return;

        await pickAndApplyConnection(cell, selectedKind.connectorKind);
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setGraphSource', async (cell: vscode.NotebookCell) => {
        const notebook = cell.notebook;
        const pickItems: (vscode.QuickPickItem & { cellIndex: number })[] = [];

        for (let i = 0; i < notebook.cellCount; i++) {
            const c = notebook.cellAt(i);
            if (c.index >= cell.index) break;
            if (c.document.languageId === 'json') {
                const tbl = c.metadata?.tableName || `cell_${c.index}`;
                pickItems.push({
                    label: tbl,
                    description: `Cell ${c.index + 1} (JSON Compose)`,
                    cellIndex: c.index
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

        // Persist both the cell's current position (fast path — resolved
        // directly, not by an unbounded label re-scan that could match the
        // wrong cell if two JSON cells share a table name) and its table name
        // (a stable fallback vegaGraphHandler uses to re-locate the source
        // cell if this notebook is edited afterward and cell indices shift).
        const edit = new vscode.WorkspaceEdit();
        const newMetadata = {
            ...(cell.metadata || {}),
            graphSourceCell: selected.cellIndex,
            graphSourceCellName: selected.label
        };
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.setGraphDataPath', async (cell: vscode.NotebookCell) => {
        const currentPath = cell.metadata?.graphDataPath || '';
        const newPath = await vscode.window.showInputBox({
            prompt: 'Enter dot-path to data key in the JSON (e.g. "orders" or "dashboard.items"). Leave empty for root.',
            value: currentPath,
            placeHolder: 'e.g. orders'
        });

        if (newPath === undefined) return;

        const edit = new vscode.WorkspaceEdit();
        const newMetadata = { ...(cell.metadata || {}), graphDataPath: newPath || undefined };
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
    }));

    context.subscriptions.push(safeRegisterCommand('vura-notebook.exportVegaGraphPdf', async (cell: vscode.NotebookCell) => {
        const storagePath = context.storageUri?.fsPath || context.globalStorageUri?.fsPath || require('os').tmpdir();
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
