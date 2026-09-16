import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ConnectionProfile, ConnectorKind } from '@vura-data-os/core-sdk';

export type AuthMode = 'ServicePrincipal' | 'DeviceCode' | 'SqlLogin' | 'WindowsAuth';

export interface SqlProfile {
    id: string; // Unique ID (usually lowercase name with dashes)
    name: string;
    authMode: AuthMode;
    server: string;
    database: string;
    port: number;
    // Specific fields, populated depending on AuthMode
    clientId?: string;
    tenantId?: string;
    username?: string;
    domain?: string;
}

export class ConnectionManager {
    public static readonly PROFILES_KEY = 'vura-sql-profiles';
    public static readonly ACTIVE_PROFILE_KEY = 'vura-sql-active-profile';
    public static readonly CONNECTION_PROFILES_KEY = 'vura-connection-profiles';
    /** Opt-in toggle (off by default) for mirroring non-secret connection config to `.vura/connections.json`. */
    public static readonly MIRROR_TO_WORKSPACE_KEY = 'vura-mirror-connections-to-workspace';

    private static _statusBarItem: vscode.StatusBarItem;
    /** Per-file write queue so overlapping mirror writes serialize instead of interleaving. */
    private static _mirrorWriteQueues: Map<string, Promise<void>> = new Map();

    public static initialize(context: vscode.ExtensionContext) {
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._statusBarItem.command = 'vura-sql.switchProfile';
        context.subscriptions.push(this._statusBarItem);
        this.updateStatusBar(context);
    }

    public static getProfiles(context: vscode.ExtensionContext): SqlProfile[] {
        return context.globalState.get<SqlProfile[]>(this.PROFILES_KEY) || [];
    }

    public static getActiveProfileId(context: vscode.ExtensionContext): string | undefined {
        return context.globalState.get<string>(this.ACTIVE_PROFILE_KEY);
    }

    public static getActiveProfile(context: vscode.ExtensionContext): SqlProfile | undefined {
        const profiles = this.getProfiles(context);
        const activeId = this.getActiveProfileId(context);
        if (!activeId) return profiles[0]; // default to first if none active
        return profiles.find(p => p.id === activeId) || profiles[0];
    }

    public static async saveProfile(context: vscode.ExtensionContext, profile: SqlProfile, secretPayload?: string): Promise<void> {
        let profiles = this.getProfiles(context);
        const index = profiles.findIndex(p => p.id === profile.id);

        if (index > -1) {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }

        await context.globalState.update(this.PROFILES_KEY, profiles);

        // Save sensitive payload if provided (Like Client Secret or SQL Password)
        if (secretPayload) {
            await context.secrets.store(`secret-${profile.id}`, secretPayload);
        }

        if (!this.getActiveProfileId(context)) {
            await this.setActiveProfile(context, profile.id);
        } else if (this.getActiveProfileId(context) === profile.id) {
            this.updateStatusBar(context); // Update UI just in case name changed
            // The active profile's own connection details (server/database/auth) may have
            // just changed — the cached schema could now point at the wrong server.
            this.invalidateSchemaCache();
            vscode.commands.executeCommand('vura-sql.refreshSchema');
        }
    }

    public static async removeProfile(context: vscode.ExtensionContext, profileId: string): Promise<void> {
        let profiles = this.getProfiles(context);
        profiles = profiles.filter(p => p.id !== profileId);
        await context.globalState.update(this.PROFILES_KEY, profiles);

        // Remove associated secret
        try {
            await context.secrets.delete(`secret-${profileId}`);
        } catch(e) { /* ignore if not found */ }

        if (this.getActiveProfileId(context) === profileId) {
            if (profiles.length > 0) {
                await this.setActiveProfile(context, profiles[0].id);
            } else {
                await context.globalState.update(this.ACTIVE_PROFILE_KEY, undefined);
                this.updateStatusBar(context);
                this.invalidateSchemaCache();
                vscode.commands.executeCommand('vura-sql.refreshSchema');
            }
        }
    }

    public static async setActiveProfile(context: vscode.ExtensionContext, profileId: string): Promise<void> {
        await context.globalState.update(this.ACTIVE_PROFILE_KEY, profileId);
        this.updateStatusBar(context);
        // The Schema Explorer / SQL IntelliSense cache is keyed to whichever connection was
        // active when it first loaded and never re-queries on its own — drop it here, the one
        // choke point every "switch active connection" path runs through, so the next tree
        // expand / completion request re-fetches against the newly active connection.
        this.invalidateSchemaCache();
        // Refresh Config UI if open
        vscode.commands.executeCommand('vura-connections.configView.focus');
        vscode.commands.executeCommand('vura-connections.refreshConfigurationPanel');
        vscode.commands.executeCommand('vura-sql.refreshSchema');
    }

    /**
     * Lazy require to avoid a hard circular import (schemaService.ts already imports
     * ConnectionManager from this file) — same pattern already used elsewhere in this
     * extension (e.g. extension.ts's cleanNotebookSession) to sidestep exactly this.
     */
    private static invalidateSchemaCache(): void {
        try {
            require('./schemaService').SchemaService.invalidate();
        } catch (e) {
            console.error('Failed to invalidate schema cache:', e);
        }
    }

    public static async getSecretForProfile(context: vscode.ExtensionContext, profileId: string): Promise<string | undefined> {
        return context.secrets.get(`secret-${profileId}`);
    }

    public static updateStatusBar(context: vscode.ExtensionContext) {
        const active = this.getActiveProfile(context);
        if (active) {
            this._statusBarItem.text = `$(database) SQL Profile: ${active.name}`;
            this._statusBarItem.show();
        } else {
            this._statusBarItem.text = `$(database) No SQL Profile`;
            this._statusBarItem.show();
        }
    }

    // ─── Generic connection profiles (non-SQL connectors) ───────────────────

    public static getConnectionProfiles(context: vscode.ExtensionContext): ConnectionProfile[] {
        return context.globalState.get<ConnectionProfile[]>(this.CONNECTION_PROFILES_KEY) || [];
    }

    public static async saveConnectionProfile(context: vscode.ExtensionContext, profile: ConnectionProfile, secret?: string): Promise<void> {
        const profiles = this.getConnectionProfiles(context);
        const index = profiles.findIndex(p => p.id === profile.id);
        if (index > -1) {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }
        await context.globalState.update(this.CONNECTION_PROFILES_KEY, profiles);
        if (secret) {
            await context.secrets.store(`secret-${profile.id}`, secret);
        }
        await this.mirrorConnectionsToWorkspaceIfEnabled(context);
    }

    public static async removeConnectionProfile(context: vscode.ExtensionContext, profileId: string): Promise<void> {
        const profiles = this.getConnectionProfiles(context).filter(p => p.id !== profileId);
        await context.globalState.update(this.CONNECTION_PROFILES_KEY, profiles);
        try {
            await context.secrets.delete(`secret-${profileId}`);
        } catch (e) { /* ignore if not found */ }
        await this.mirrorConnectionsToWorkspaceIfEnabled(context);
    }

    /**
     * Deletes a connection profile regardless of which store it actually lives in — a
     * client-supplied `kind` is not reliable enough to dispatch on: getAllConnectionProfiles()
     * synthesizes a 'dataverse'-kind entry for any legacy SqlProfile with
     * authMode === 'ServicePrincipal' (see getAllConnectionProfiles below), so a UI row
     * labeled "dataverse" may really be a row stored under the SQL profile store. Deleting
     * by the wrong store silently no-ops instead of removing anything.
     */
    public static async removeAnyConnectionProfile(context: vscode.ExtensionContext, profileId: string): Promise<void> {
        if (this.getProfiles(context).some(p => p.id === profileId)) {
            await this.removeProfile(context, profileId);
            return;
        }
        await this.removeConnectionProfile(context, profileId);
    }

    // ─── Workspace `.vura/connections.json` mirror (opt-in, non-secret config only) ─

    public static isWorkspaceMirrorEnabled(context: vscode.ExtensionContext): boolean {
        return context.globalState.get<boolean>(this.MIRROR_TO_WORKSPACE_KEY, false);
    }

    public static async setWorkspaceMirrorEnabled(context: vscode.ExtensionContext, enabled: boolean): Promise<void> {
        await context.globalState.update(this.MIRROR_TO_WORKSPACE_KEY, enabled);
        if (enabled) {
            await this.mirrorConnectionsToWorkspaceIfEnabled(context);
        }
    }

    /**
     * Best-effort mirror of non-secret connection config to `<workspaceFolder>/.vura/connections.json`
     * so it can be committed to git. Off by default (isWorkspaceMirrorEnabled), skipped when no
     * workspace folder is open, and never includes secret values — those stay in context.secrets.
     * Writes are atomic (tmp file + rename, matching vura-io's saveManifestAtomically) and
     * serialized per target path so two rapid saves can't interleave partial writes.
     */
    private static async mirrorConnectionsToWorkspaceIfEnabled(context: vscode.ExtensionContext): Promise<void> {
        if (!this.isWorkspaceMirrorEnabled(context)) return;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const targetDir = path.join(workspaceRoot, '.vura');
        const targetPath = path.join(targetDir, 'connections.json');
        // Non-secret profiles only — the same shape ConnectionManager already returns elsewhere.
        const mirrorPayload = this.getAllConnectionProfiles(context);

        const previous = this._mirrorWriteQueues.get(targetPath) ?? Promise.resolve();
        const next = previous
            .catch(() => {}) // don't let a prior failure block future writes
            .then(async () => {
                await fs.mkdir(targetDir, { recursive: true });
                const tmpPath = path.join(targetDir, `connections.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`);
                await fs.writeFile(tmpPath, JSON.stringify(mirrorPayload, null, 2));
                await fs.rename(tmpPath, targetPath);
            });
        this._mirrorWriteQueues.set(targetPath, next);
        await next;
    }

    /**
     * Every connection profile the host knows about, regardless of storage generation:
     * legacy SqlProfile entries (mapped to kind 'sql') plus the generic profile store.
     * `kind` filters the merged result when given.
     */
    public static getAllConnectionProfiles(context: vscode.ExtensionContext, kind?: ConnectorKind): ConnectionProfile[] {
        const sqlProfiles: ConnectionProfile[] = this.getProfiles(context).map(p => ({
            id: p.id,
            name: p.name,
            kind: 'sql',
            config: {
                authMode: p.authMode,
                server: p.server,
                database: p.database,
                port: p.port,
                clientId: p.clientId,
                tenantId: p.tenantId,
                username: p.username,
                domain: p.domain
            }
        }));
        const all = [...sqlProfiles, ...this.getConnectionProfiles(context)];

        // NOTE: this used to also synthesize a phantom 'dataverse'-kind duplicate for
        // every SqlProfile with authMode === 'ServicePrincipal', as a backward-compat
        // bridge from before Dataverse had its own first-class ConnectionProfile kind.
        // That silently doubled every Service-Principal SQL/Azure SQL connection a user
        // created (unrelated to Dataverse at all) into a second bogus "Dataverse" entry —
        // removed now that Dataverse has real connector-kind support of its own.

        return kind ? all.filter(p => p.kind === kind) : all;
    }

    public static getConnectionProfileById(context: vscode.ExtensionContext, profileId: string): ConnectionProfile | undefined {
        return this.getAllConnectionProfiles(context).find(p => p.id === profileId);
    }

    public static async getSecretForConnectionProfile(context: vscode.ExtensionContext, profileId: string): Promise<string | undefined> {
        return context.secrets.get(`secret-${profileId}`);
    }
}
