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
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    workspace: {
        registerNotebookSerializer: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onDidSaveNotebookDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onDidOpenNotebookDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        getConfiguration: jest.fn().mockReturnValue({
            get: (key: string, defaultValue: any) => defaultValue,
        }),
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
});
