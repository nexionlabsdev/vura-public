import * as vscode from 'vscode';
import * as path from 'path';
import { IVuraEnvironment, SqlProfile, DuckDbManager, ContextManager } from '@vura-data-os/vura-runner';
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
        private cell?: vscode.NotebookCell
    ) {
        if (!context.storageUri) {
            throw new Error("Workspace storage is required to run VURA Notebooks.");
        }
        this.storagePath = context.storageUri.fsPath;
        this.extensionPath = context.extensionPath;

        const crypto = require('crypto');
        if (cell) {
            this.notebookDir = path.dirname(cell.notebook.uri.fsPath);
            this.notebookId = crypto.createHash('md5').update(cell.notebook.uri.fsPath).digest('hex');
        } else {
            this.notebookDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.storagePath;
            this.notebookId = 'global';
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

    public async getPythonVenvPath(): Promise<string | undefined> {
        return this.context.workspaceState.get<string>('vura-notebook-pythonVenv');
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
