import * as vscode from 'vscode';
import * as path from 'path';
import { ProviderRegistry } from '@vura-data-os/core-sdk';
import { VsCodeEnvironment } from './VsCodeEnvironment';
import { VsCodeCellLogger } from './VsCodeCellLogger';
import { VuraRunner, FlownbCell, handleFileIngestion } from '@vura-data-os/vura-runner';

export class NotebookController {
    readonly controllerId = 'vura-notebook-controller';
    readonly notebookType = 'vura-notebook';
    readonly label = 'VURA Polyglot';
    readonly supportedLanguages = ['sql', 'python', 'javascript', 'html', 'shellscript', 'json', 'vega-lite', 'vura-terminal', 'http-input'];

    private readonly _controller: vscode.NotebookController;
    private _executionOrder = 0;

    constructor(private context: vscode.ExtensionContext) {
        this._controller = vscode.notebooks.createNotebookController(
            this.controllerId,
            this.notebookType,
            this.label
        );

        this._controller.supportedLanguages = this.supportedLanguages;
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this._execute.bind(this);
    }

    dispose() {
        this._controller.dispose();
    }

    private async _execute(
        cells: vscode.NotebookCell[],
        _notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController
    ): Promise<void> {
        // Single-cell execution ignores runWhen and group abort — use Run All to respect flow control.
        if (cells.length === 1) {
            await this._doExecution(cells[0]);
            return;
        }

        if (cells.length === 0) return;

        const allVsCodeCells = _notebook.getCells();
        const flownbCells: FlownbCell[] = allVsCodeCells.map(c => ({
            kind: c.kind === vscode.NotebookCellKind.Code ? 2 : 1,
            language: c.document.languageId,
            value: c.document.getText(),
            metadata: { ...c.metadata }
        }));

        const executions = new Map<number, vscode.NotebookCellExecution>();
        
        for (let i = 0; i < allVsCodeCells.length; i++) {
            const cell = allVsCodeCells[i];
            if (cell.kind === vscode.NotebookCellKind.Code) {
                const execution = this._controller.createNotebookCellExecution(cell);
                execution.executionOrder = ++this._executionOrder;
                executions.set(i, execution);
            }
        }

        let currentCellLogger: VsCodeCellLogger | null = null;
        const proxyLogger: any = {
            logText: async (t: string) => { await currentCellLogger?.logText(t); },
            logError: async (e: any) => { await currentCellLogger?.logError(e); },
            logHtml: async (h: string) => { await currentCellLogger?.logHtml(h); },
            logJson: async (j: any) => { await currentCellLogger?.logJson(j); },
            replaceOutput: async (h: string) => { await currentCellLogger?.replaceOutput(h); },
            logMultiple: async (m: any) => { await currentCellLogger?.logMultiple(m); },
            clearOutput: async () => { await currentCellLogger?.clearOutput(); }
        };

        const env = new VsCodeEnvironment(this.context, allVsCodeCells[0]);
        const runner = new VuraRunner(env);

        await runner.executeNotebook(flownbCells, proxyLogger, process.env as any, {
            onCellStart: (cellIndex) => {
                const execution = executions.get(cellIndex);
                if (execution) {
                    execution.start(Date.now());
                    execution.clearOutput();
                    currentCellLogger = new VsCodeCellLogger(execution);
                }
            },
            onCellEnd: (cellIndex, cellResult) => {
                const execution = executions.get(cellIndex);
                if (execution) {
                    if (cellResult.status === 'skipped') {
                        execution.start(Date.now());
                        execution.clearOutput();
                        execution.appendOutput([new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text("Skipped — runWhen condition not met", "application/vnd.code.notebook.stdout")
                        ])]);
                        execution.end(undefined, Date.now());
                    } else if (cellResult.status === 'error') {
                        execution.end(false, Date.now());
                    } else {
                        execution.end(true, Date.now());
                    }
                }
            }
        });
    }

    private async _doExecution(cell: vscode.NotebookCell): Promise<void> {
        const execution = this._controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this._executionOrder;
        execution.start(Date.now());
        execution.clearOutput();

        try {
            if (cell.document.languageId === 'shellscript' || cell.document.languageId === 'vura-terminal') {
                await this._executeTerminal(cell, execution);
                execution.end(true, Date.now());
                return;
            }

            const env = new VsCodeEnvironment(this.context, cell);
            const logger = new VsCodeCellLogger(execution);
            const runner = new VuraRunner(env);

            const flownbCell: FlownbCell = {
                kind: cell.kind === vscode.NotebookCellKind.Code ? 2 : 1,
                language: cell.document.languageId,
                value: cell.document.getText(),
                metadata: { ...cell.metadata }
            };

            const notebookCells: FlownbCell[] = [];
            for (let i = 0; i < cell.notebook.cellCount; i++) {
                const c = cell.notebook.cellAt(i);
                notebookCells.push({
                    kind: c.kind === vscode.NotebookCellKind.Code ? 2 : 1,
                    language: c.document.languageId,
                    value: c.document.getText(),
                    metadata: { ...c.metadata }
                });
            }

            await runner.executeCell(flownbCell, cell.index, notebookCells, logger);

            execution.end(true, Date.now());
        } catch (err: any) {
            await execution.replaceOutput([new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(err as Error)
            ])]);
            execution.end(false, Date.now());
        }
    }

    private async _executeTerminal(cell: vscode.NotebookCell, execution: vscode.NotebookCellExecution) {
        const rawCode = cell.document.getText();
        const lines = rawCode.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('--')) {
                continue; // Skip empty lines and comments
            }

            if (trimmed.startsWith('!')) {
                const commandRoot = trimmed.split(' ')[0]; // e.g., !sync_dataverse
                const env = new VsCodeEnvironment(this.context, cell);
                const logger = new VsCodeCellLogger(execution);

                if (commandRoot === '!ingest-file') {
                    try {
                        // Regex to parse: !ingest-file "path" type "sheet" -> targetTable
                        // Or: !ingest-file "path" type -> targetTable
                        const match = trimmed.match(/^!ingest-file\s+"([^"]+)"\s+(csv|excel|parquet|json)(?:\s+"([^"]+)")?\s+->\s+([^\s]+)$/);
                        if (match) {
                            await handleFileIngestion(match[1], match[2], match[4], match[3], env, logger);
                            continue;
                        } else {
                            throw new Error('Invalid !ingest-file command syntax');
                        }
                    } catch (e: any) {
                        throw e;
                    }
                }

                const provider = ProviderRegistry.getInstance().getProviderForCommand(commandRoot);
                if (provider) {
                    const flownbCell: FlownbCell = {
                        kind: cell.kind === vscode.NotebookCellKind.Code ? 2 : 1,
                        language: cell.document.languageId,
                        value: cell.document.getText(),
                        metadata: { ...cell.metadata }
                    };
                    await provider.handleCommand(commandRoot, flownbCell, logger, env, trimmed);
                } else {
                    // Fallback to standard shell execution
                    const shellCommand = trimmed.substring(1).trim();
                    if (!shellCommand) continue;

                    try {
                        let envToUse = { ...process.env };

                        // If it's a pip or python command, try to inject VENV path if available
                        if (/^(pip|python)(3(\.\d+)?)?\s/.test(shellCommand)) {
                            const venvFolder = this.context.workspaceState.get<string>('vura-notebook-pythonVenv');
                            if (venvFolder) {
                                const isWin = process.platform === 'win32';
                                const venvBin = isWin ? path.join(venvFolder, 'Scripts') : path.join(venvFolder, 'bin');
                                envToUse['PATH'] = `${venvBin}${path.delimiter}${envToUse['PATH']}`;
                            }
                        }

                        // Run the process in the shell using VuraRunner
                        // Use shell: true so that commands like 'npm install' or complex arguments are resolved correctly by the OS shell
                        const child_process = require('child_process');
                        await new Promise<void>((resolve, reject) => {
                            const child = child_process.spawn(shellCommand, { 
                                cwd: this.context.storageUri!.fsPath, 
                                env: envToUse, 
                                shell: true 
                            });
                            
                            child.stdout.on('data', async (data: any) => {
                                await logger.logText(data.toString());
                            });
                            
                            child.stderr.on('data', async (data: any) => {
                                await logger.logText(data.toString());
                            });
                            
                            child.on('close', (code: number) => {
                                if (code === 0) {
                                    resolve();
                                } else {
                                    reject(new Error(`Command exited with code ${code}`));
                                }
                            });
                        });
                    } catch (err: any) {
                        throw new Error(`Terminal command execution failed for "${trimmed}": ${err.message}`);
                    }
                }
            } else {
                throw new Error(`Unknown syntax: "${trimmed}". Terminal cells expect commands starting with '!'.`);
            }
        }
    }
}

