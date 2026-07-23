import * as vscode from 'vscode';
import { ConfigViewProvider } from './configViewProvider';
import { ResultViewProvider } from './resultViewProvider';
import { SqlService } from '@vura-data-os/vura-runner';
import { OutputChannelLogger } from './OutputChannelLogger';
import { SchemaService } from './schemaService';
import { SchemaExplorerProvider } from './schemaExplorer';
import { SQLIntelliSenseProvider } from './intellisenseProvider';
import { ConnectionManager } from './connectionManager';
import { HistoryExplorerProvider, HistoryRecord } from './historyExplorer';
import { NotebookSerializer } from './notebookSerializer';
import { NotebookController } from './notebookController';
import { NotebookStatusBarProvider, registerNotebookStatusBarCommands } from './notebookStatusBar';
import { handleGridExport, handleVisualExport } from './notebook/exportHandler';
import { handleGridCopy } from './notebook/copyHandler';
import { saveNotebookOutputs, restoreNotebookOutputs } from './notebook/outputStorage';

let outputChannel: vscode.OutputChannel;
let notebookController: NotebookController | undefined;
let statusBarItem: vscode.StatusBarItem;
let activeSqlService: SqlService | null = null;
export let resultProvider: ResultViewProvider;

import { ProviderRegistry } from '@vura-data-os/core-sdk';
import { VsCodeEnvironment } from './VsCodeEnvironment';

export function activate(context: vscode.ExtensionContext) {
    console.log('Multi-Profile MSSQL Client is now active');

    outputChannel = vscode.window.createOutputChannel('VURA SQL Output');
    context.subscriptions.push(outputChannel);
    SchemaService.initialize(outputChannel);

    ConnectionManager.initialize(context);

    // Register Webview Provider for the SideBar Configuration
    const configProvider = new ConfigViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ConfigViewProvider.viewType, configProvider)
    );

    // Register Results Panel
    resultProvider = new ResultViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ResultViewProvider.viewType, resultProvider)
    );

    // Register Schema Explorer TreeView
    const schemaExplorer = new SchemaExplorerProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('vura-sql.schemaExplorer', schemaExplorer)
    );

    // Register History Explorer TreeView
    const historyExplorer = new HistoryExplorerProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('vura-sql.historyExplorer', historyExplorer)
    );

    // Register Notebook Providers
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer('vura-notebook', new NotebookSerializer())
    );

    notebookController = new NotebookController(context);
    context.subscriptions.push(notebookController);

    context.subscriptions.push(
        vscode.notebooks.registerNotebookCellStatusBarItemProvider('vura-notebook', new NotebookStatusBarProvider(context))
    );

    registerNotebookStatusBarCommands(context);

    // Register Output Storage Event Listeners
    context.subscriptions.push(
        vscode.workspace.onDidSaveNotebookDocument(async (doc) => {
            await saveNotebookOutputs(doc);
        }),
        vscode.workspace.onDidOpenNotebookDocument(async (doc) => {
            await restoreNotebookOutputs(doc);
        })
    );

    const refreshSchemaCmd = vscode.commands.registerCommand('vura-sql.refreshSchema', () => {
        schemaExplorer.refresh();
    });
    context.subscriptions.push(refreshSchemaCmd);

    // Register SQL IntelliSense
    const intelliSenseProvider = new SQLIntelliSenseProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('sql', intelliSenseProvider, '.')
    );

    const switchProfileCmd = vscode.commands.registerCommand('vura-sql.switchProfile', async () => {
        const profiles = ConnectionManager.getProfiles(context);
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles available. Create one first!');
            return;
        }

        const items = profiles.map(p => ({ label: p.name, description: p.authMode, profileId: p.id }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select active SQL Profile' });
        if (selected) {
            await ConnectionManager.setActiveProfile(context, selected.profileId);
            schemaExplorer.refresh();
        }
    });

    const injectSqlCmd = vscode.commands.registerCommand('vura-sql.history.inject', (record: HistoryRecord) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'sql') {
            editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, record.fullSql);
            });
        } else {
            vscode.workspace.openTextDocument({ language: 'sql', content: record.fullSql }).then(doc => {
                vscode.window.showTextDocument(doc);
            });
        }
    });

    const executeCmd = vscode.commands.registerCommand('universalSql.execute', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sql') {
            vscode.window.showErrorMessage('No active SQL file. Open a .sql file to execute.');
            return;
        }

        const selection = editor.selection;
        const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

        if (!text || text.trim() === '') {
            vscode.window.showErrorMessage('SQL script is empty.');
            return;
        }

        const activeProfile = ConnectionManager.getActiveProfile(context);

        if (!activeProfile) {
            vscode.commands.executeCommand('vura-sql.configView.focus');
            vscode.window.showErrorMessage('No connection profile found. Please create one in the sidebar.');
            return;
        }

        resultProvider.updateLoading();

        let startTime = Date.now();
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.text = `$(sync~spin) Executing SQL... (0.0s)`;
        statusBarItem.show();

        const timerInterval = setInterval(() => {
            const currentElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            statusBarItem.text = `$(sync~spin) Executing SQL... (${currentElapsed}s)`;
        }, 100);

        try {
            const secretPayload = await ConnectionManager.getSecretForProfile(context, activeProfile.id);
            activeSqlService = new SqlService(activeProfile, secretPayload);
            
            outputChannel.show(true);
            const logger = new OutputChannelLogger(outputChannel);
            const data = await activeSqlService.executeSql(text, logger);
            
            clearInterval(timerInterval);
            const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            statusBarItem.text = `$(check) Executed in ${totalElapsed}s - ${data.length} records`;
            setTimeout(() => statusBarItem.dispose(), 3000);
            
            resultProvider.updateResults(data, totalElapsed);
            
            // Log History
            await HistoryExplorerProvider.pushRecord(context, activeProfile.name, text, 'success', totalElapsed);
            historyExplorer.refresh();

        } catch (error: any) {
            clearInterval(timerInterval);
            statusBarItem.text = `$(error) Execution failed`;
            setTimeout(() => statusBarItem.dispose(), 3000);
            
            resultProvider.updateError(error.message, activeProfile.name);

            // Log History Fake Elapsed
            const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            await HistoryExplorerProvider.pushRecord(context, activeProfile.name, text, 'error', totalElapsed);
            historyExplorer.refresh();

        } finally {
            activeSqlService = null;
        }
    });

    const cancelCmd = vscode.commands.registerCommand('universalSql.cancel', () => {
        if (activeSqlService) {
            activeSqlService.cancelExecution();
            outputChannel.appendLine('Execution was manually cancelled.');
            resultProvider.updateError('Execution manually cancelled by user.', 'System');
            statusBarItem.text = `$(stop-circle) Cancelled`;
            setTimeout(() => statusBarItem.dispose(), 3000);
            vscode.window.showInformationMessage('SQL Execution Cancelled.');
            activeSqlService = null;
        } else {
            vscode.window.showInformationMessage('No active execution to cancel.');
        }
    });

    const exportCellOutputCmd = vscode.commands.registerCommand('vura-notebook.exportCellOutput', async (cell: vscode.NotebookCell) => {
        if (!cell) return;
        
        // Check if the cell has visual HTML/Vega output
        const hasVisualOutput = cell.outputs.some(out => 
            out.items.some(i => i.mime === 'application/vnd.vura.visual')
        ) && (cell.document.languageId === 'vega-lite' || cell.document.languageId === 'html' || cell.document.languageId === 'json');

        if (hasVisualOutput) {
            await handleVisualExport(cell, context);
            return;
        }

        const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
        if (context.storageUri) {
            await handleGridExport(tableName, context);
        } else {
            vscode.window.showErrorMessage('Storage context not initialized for exporting.');
        }
    });

    const copyCellOutputCmd = vscode.commands.registerCommand('vura-notebook.copyCellOutput', async (cell: vscode.NotebookCell) => {
        if (!cell) return;
        const tableName = cell.metadata?.tableName || `cell_${cell.index}`;
        if (context.storageUri) {
            await handleGridCopy(tableName, context);
        } else {
            vscode.window.showErrorMessage('Storage context not initialized for copying.');
        }
    });

    const toggleHttpOutputCmd = vscode.commands.registerCommand('vura-notebook.toggleHttpOutput', async (cell: vscode.NotebookCell) => {
        if (!cell) return;
        const currentMeta = cell.metadata || {};
        const isHttpOutput = currentMeta.vura_is_http_output;
        
        const newMeta = { ...currentMeta, vura_is_http_output: !isHttpOutput };
        const edit = new vscode.WorkspaceEdit();
        const notebookEdit = vscode.NotebookEdit.updateCellMetadata(cell.index, newMeta);
        edit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(edit);
        
        vscode.window.showInformationMessage(`Cell ${cell.index + 1} is ${!isHttpOutput ? 'now' : 'no longer'} the API HTTP Output.`);
    });

    const deleteHistoryEntryCmd = vscode.commands.registerCommand('vura-sql.history.deleteEntry', async (item: any) => {
        if (item?.record?.id) {
            await historyExplorer.deleteRecord(item.record.id);
        }
    });

    const clearHistoryCmd = vscode.commands.registerCommand('vura-sql.history.clearAll', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Clear entire query history?', { modal: true }, 'Clear All'
        );
        if (confirm === 'Clear All') {
            await historyExplorer.clearHistory();
        }
    });

    context.subscriptions.push(executeCmd, cancelCmd, switchProfileCmd, injectSqlCmd, exportCellOutputCmd, copyCellOutputCmd, toggleHttpOutputCmd, deleteHistoryEntryCmd, clearHistoryCmd);

    return {
        registerProvider: async (id: string, provider: any) => {
            await ProviderRegistry.getInstance().registerProvider(id, provider, new VsCodeEnvironment(context));
        },
        getConnectionManager: () => {
            return require('./connectionManager').ConnectionManager;
        },
        getDuckDbManager: () => {
            // Shared with vura-runner. Callers must pass an IVuraEnvironment
            // (e.g. `new VsCodeEnvironment(context, cell)`), not the raw
            // vscode.ExtensionContext.
            return require('@vura-data-os/vura-runner').DuckDbManager;
        }
    };
}

export function deactivate() {
    if (activeSqlService) {
        activeSqlService.cancelExecution();
    }
    if (notebookController) {
        notebookController.dispose();
    }
}
