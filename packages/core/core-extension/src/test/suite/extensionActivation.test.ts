import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock VS Code API module before extension require
const mockSubscriptions: any[] = [];
const mockVscode = {
    window: {
        createOutputChannel: jest.fn().mockReturnValue({
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        }),
        registerWebviewViewProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        registerTreeDataProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        createStatusBarItem: jest.fn().mockReturnValue({
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
        }),
        createWebviewPanel: jest.fn().mockReturnValue({
            webview: {
                html: '',
                onDidReceiveMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
                postMessage: jest.fn(),
            },
            onDidDispose: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            reveal: jest.fn(),
            dispose: jest.fn(),
        }),
    },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    extensions: {
        getExtension: jest.fn().mockReturnValue(undefined),
        all: [],
        onDidChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    },
    workspace: {
        registerNotebookSerializer: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onDidSaveNotebookDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onDidOpenNotebookDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        getConfiguration: jest.fn().mockReturnValue({
            get: (key: string, defaultValue: any) => defaultValue,
        }),
        workspaceFolders: undefined,
    },
    notebooks: {
        registerNotebookCellStatusBarItemProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        createNotebookController: jest.fn().mockReturnValue({
            supportedLanguages: [],
            supportsExecutionOrder: true,
            executeHandler: undefined,
            dispose: jest.fn(),
        }),
    },
    commands: {
        registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        executeCommand: jest.fn(),
    },
    languages: {
        registerCompletionItemProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
    },
    ThemeColor: class { constructor(public id: string) {} },
    TreeItem: class { constructor(public label: string) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
        event = jest.fn();
        fire = jest.fn();
    },
};

jest.mock('vscode', () => mockVscode, { virtual: true });

import { activate } from '../../extension';

describe('Core Extension Activation & @duckdb/node-api Integration', () => {
    let tempStorage: string;
    let mockContext: any;

    beforeAll(async () => {
        tempStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-ext-act-test-'));
        mockContext = {
            subscriptions: mockSubscriptions,
            extensionUri: { fsPath: tempStorage, path: tempStorage },
            extensionPath: tempStorage,
            globalStorageUri: { fsPath: tempStorage, path: tempStorage },
            logUri: { fsPath: tempStorage, path: tempStorage },
            storageUri: { fsPath: tempStorage, path: tempStorage },
            globalState: { get: jest.fn(), update: jest.fn() },
            workspaceState: { get: jest.fn(), update: jest.fn() },
            secrets: { get: jest.fn(), store: jest.fn(), delete: jest.fn() },
        };
    });

    afterAll(async () => {
        await fs.rm(tempStorage, { recursive: true, force: true });
    });

    it('activates extension cleanly without throwing native ABI or DuckDB load errors', () => {
        const exports = activate(mockContext);
        expect(exports).toBeDefined();
        expect(exports.getDuckDbManager).toBeDefined();
    });

    it('retrieves DuckDbManager via extension exports and initializes in-memory database', async () => {
        const exports = activate(mockContext);
        const DuckDbManager = exports.getDuckDbManager();
        expect(DuckDbManager).toBeDefined();

        const isolated = await DuckDbManager.createIsolated();
        const res = await isolated.runQuery('SELECT 100 AS status_code');
        expect(res).toEqual([{ status_code: 100 }]);
        isolated.dispose();
    });

    it('registers the Environment Hub command and opens a webview panel tab', () => {
        // Isolated module registry: HubPanel keeps a module-level singleton
        // (`HubPanel.current`), which would already be set by an earlier
        // activate() call in this file and short-circuit createWebviewPanel
        // with a plain .reveal() instead.
        jest.isolateModules(() => {
            const { activate: isolatedActivate } = require('../../extension');
            (mockVscode.window.createWebviewPanel as jest.Mock).mockClear();
            (mockVscode.commands.registerCommand as jest.Mock).mockClear();

            // globalState.get() defaults to returning undefined (no 'hasOpenedOnce'
            // flag yet), so activate() itself opens the Hub once as a first-run tab —
            // this is where createWebviewPanel actually gets called.
            isolatedActivate(mockContext);

            expect(mockVscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'vura.environmentHub',
                'VURA Environment Hub',
                mockVscode.ViewColumn.One,
                expect.objectContaining({ enableScripts: true })
            );

            const registerCommandCalls = (mockVscode.commands.registerCommand as jest.Mock).mock.calls;
            const hubCommand = registerCommandCalls.find(([id]) => id === 'vura.openEnvironmentHub');
            expect(hubCommand).toBeDefined();

            // Re-invoking the command while the tab is already open should reveal it,
            // not open a second panel.
            (mockVscode.window.createWebviewPanel as jest.Mock).mockClear();
            const [, handler] = hubCommand!;
            handler();
            expect(mockVscode.window.createWebviewPanel).not.toHaveBeenCalled();
        });
    });
});
