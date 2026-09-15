import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { IVuraEnvironment, SqlProfile, DuckDbManager, ContextManager } from '@vura-data-os/vura-runner';
import { ConnectionProfile, ConnectorKind } from '@vura-data-os/core-sdk';
import { ConnectionManager } from './connectionManager';

export class VsCodeEnvironment implements IVuraEnvironment {
    public storagePath: string;
    public extensionPath: string;
    public notebookDir: string;
    public notebookId: string;

    /**
     * `cell` is omitted when constructing an environment for Add-on activation
     * (registerProvider), where there's no notebook/cell in scope yet — per-cell
     * dispatch always constructs a fresh, cell-scoped instance.
     */
    constructor(
        private context: vscode.ExtensionContext,
        cellOrDoc?: any
    ) {
        const baseStoragePath = context.storageUri?.fsPath || path.join(os.tmpdir(), 'vura-storage');
        this.extensionPath = context.extensionPath;

        const crypto = require('crypto');
        let notebookUri: vscode.Uri | undefined = undefined;

        if (cellOrDoc) {
            if (cellOrDoc instanceof vscode.Uri) {
                notebookUri = cellOrDoc;
            } else if (cellOrDoc.notebook && cellOrDoc.notebook.uri) {
                notebookUri = cellOrDoc.notebook.uri;
            } else if (cellOrDoc.notebookEditor && cellOrDoc.notebookEditor.notebook?.uri) {
                notebookUri = cellOrDoc.notebookEditor.notebook.uri;
            } else if (cellOrDoc.uri) {
                notebookUri = cellOrDoc.uri;
            } else if (cellOrDoc.scheme && cellOrDoc.path) {
                notebookUri = cellOrDoc as vscode.Uri;
            }
        }

        if (!notebookUri) {
            notebookUri = vscode.window.activeNotebookEditor?.notebook.uri;
        }

        if (notebookUri) {
            this.notebookDir = path.dirname(notebookUri.fsPath);
            this.notebookId = crypto.createHash('md5').update(notebookUri.fsPath).digest('hex');
            this.storagePath = path.join(baseStoragePath, 'sessions', this.notebookId);
        } else {
            this.notebookDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || baseStoragePath;
            this.notebookId = 'global';
            this.storagePath = path.join(baseStoragePath, 'global');
        }
    }

    public getConfig<T>(key: string, defaultValue: T): T {
        const config = vscode.workspace.getConfiguration();
        return config.get<T>(key, defaultValue);
    }

    public async getProfile(profileId: string): Promise<SqlProfile | undefined> {
        const profiles = ConnectionManager.getProfiles(this.context);
        return profiles.find(p => p.id === profileId) as SqlProfile | undefined;
    }

    public async getProfileSecret(profileId: string): Promise<string | undefined> {
        return ConnectionManager.getSecretForProfile(this.context, profileId);
    }

    public async getConnectionProfile(profileId: string): Promise<ConnectionProfile | undefined> {
        return ConnectionManager.getConnectionProfileById(this.context, profileId);
    }

    public async listConnectionProfiles(kind?: ConnectorKind): Promise<ConnectionProfile[]> {
        return ConnectionManager.getAllConnectionProfiles(this.context, kind);
    }

    public async getPythonVenvPath(): Promise<string | undefined> {
        return this.context.workspaceState.get<string>('vura-notebook-pythonVenv')
            || this.getConfig<string>('vura.python.venvPath', path.join(this.storagePath, 'venv'));
    }

    public async setPythonVenvPath(venvPath: string): Promise<void> {
        await this.context.workspaceState.update('vura-notebook-pythonVenv', venvPath);
    }

    public async setMapping(variable: string, targetPath: string): Promise<void> {
        await ContextManager.getInstance().setMapping(this, variable, targetPath);
    }

    public async getSecret(key: string): Promise<string | undefined> {
        return this.context.secrets.get(key);
    }

    public async setSecret(key: string, value: string): Promise<void> {
        await this.context.secrets.store(key, value);
    }

    public async deleteSecret(key: string): Promise<void> {
        await this.context.secrets.delete(key);
    }

    public async runLocalQuery(sql: string): Promise<any[]> {
        const duckDb = await DuckDbManager.getInstance(this);
        return duckDb.runQuery(sql);
    }
}
