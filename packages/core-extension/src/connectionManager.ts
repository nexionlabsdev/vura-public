import * as vscode from 'vscode';

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
    
    private static _statusBarItem: vscode.StatusBarItem;

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
            }
        }
    }

    public static async setActiveProfile(context: vscode.ExtensionContext, profileId: string): Promise<void> {
        await context.globalState.update(this.ACTIVE_PROFILE_KEY, profileId);
        this.updateStatusBar(context);
        // Refresh Config UI if open
        vscode.commands.executeCommand('vura-sql.configView.focus');
        vscode.commands.executeCommand('vura-sql.refreshConfigurationPanel');
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
}
