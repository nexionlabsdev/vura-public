import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { IVuraEnvironment, SqlProfile } from './interfaces';
import { ConnectionProfile, ConnectorKind } from '@vura-data-os/core-sdk';
import { DuckDbManager } from './services/duckDbManager';

export class CliEnvironment implements IVuraEnvironment {
    public storagePath: string;
    public notebookDir: string;
    public extensionPath: string;
    public notebookId: string;
    private configMap: Record<string, any>;
    private credentialsStorePath: string;
    private configStorePath: string;
    private secretsStorePath: string;
    private connectionsStorePath: string;

    constructor(notebookDir: string, envFilePath?: string, sessionScope?: string) {
        this.notebookDir = path.resolve(notebookDir);
        this.extensionPath = path.resolve(__dirname, '..'); // package root

        const crypto = require('crypto');
        const scope = sessionScope || process.env.VURA_SESSION_ID || '';
        const hashInput = scope ? `${this.notebookDir}:${scope}` : this.notebookDir;
        this.notebookId = crypto.createHash('md5').update(hashInput).digest('hex');
        this.storagePath = path.join(process.cwd(), '.vura', 'storage', 'sessions', this.notebookId);

        // Load dotenv if specified
        if (envFilePath) {
            require('dotenv').config({ path: path.resolve(envFilePath) });
        } else {
            require('dotenv').config();
        }

        const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
        const vuraDir = process.env.VURA_HOME || path.join(homeDir, '.vura');
        this.credentialsStorePath = path.join(vuraDir, 'credentials.json');
        this.configStorePath = path.join(vuraDir, 'config.json');
        this.secretsStorePath = path.join(vuraDir, 'secrets.json');
        this.connectionsStorePath = path.join(vuraDir, 'connections.json');

        // getConfig() is synchronous (to match VsCodeEnvironment's config API), so the
        // persisted store is loaded eagerly here rather than lazily via loadConfigStore().
        try {
            this.configMap = JSON.parse(fsSync.readFileSync(this.configStorePath, 'utf8'));
        } catch {
            try {
                // Fallback to local workspace .vura/config.json if available
                const localConfig = path.join(process.cwd(), '.vura', 'config.json');
                this.configMap = JSON.parse(fsSync.readFileSync(localConfig, 'utf8'));
            } catch {
                this.configMap = {};
            }
        }
    }

    private async loadConfigStore(): Promise<Record<string, any>> {
        try {
            const data = await fs.readFile(this.configStorePath, 'utf8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    private async saveConfigStore(config: Record<string, any>): Promise<void> {
        await fs.mkdir(path.dirname(this.configStorePath), { recursive: true });
        await fs.writeFile(this.configStorePath, JSON.stringify(config, null, 2), 'utf8');
    }

    public getConfig<T>(key: string, defaultValue: T): T {
        return this.configMap[key] !== undefined ? this.configMap[key] : defaultValue;
    }

    public async getProfile(profileId: string): Promise<SqlProfile | undefined> {
        const store = await this.loadCredentialsStore();
        return store[profileId]?.profile;
    }

    public async getProfileSecret(profileId: string): Promise<string | undefined> {
        // Priority: 1. ENV vars, 2. Store
        const envKey = `VURA_PROFILE_SECRET_${profileId.toUpperCase().replace(/-/g, '_')}`;
        if (process.env[envKey]) {
            return process.env[envKey];
        }

        const store = await this.loadCredentialsStore();
        if (store[profileId]?.secret !== undefined) {
            return store[profileId].secret;
        }

        // Non-SQL connection profiles (SharePoint, S3, OneDrive, ...) store their
        // secret in the generic secrets.json store, keyed by profile id.
        return this.getSecret(profileId);
    }

    /**
     * Every connection profile the CLI knows about, regardless of storage generation:
     * legacy SqlProfile entries in credentials.json (mapped to kind 'sql') plus the
     * generic connections.json store. Secrets for both live in the same secret space
     * (getProfileSecret / secrets.json), keyed by profile id.
     */
    public async listConnectionProfiles(kind?: ConnectorKind): Promise<ConnectionProfile[]> {
        const credStore = await this.loadCredentialsStore();
        const sqlProfiles: ConnectionProfile[] = Object.values(credStore).map(({ profile: p }) => ({
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
        const connectionsStore = await this.loadConnectionsStore();
        const all = [...sqlProfiles, ...Object.values(connectionsStore)];

        // NOTE: this used to also synthesize a phantom 'dataverse'-kind duplicate for
        // every SqlProfile with authMode === 'ServicePrincipal' — removed now that
        // Dataverse has real connector-kind support of its own (see the identical fix
        // in core-extension's ConnectionManager.getAllConnectionProfiles).

        return kind ? all.filter(p => p.kind === kind) : all;
    }

    public async getConnectionProfile(profileId: string): Promise<ConnectionProfile | undefined> {
        const all = await this.listConnectionProfiles();
        return all.find(p => p.id === profileId);
    }

    public async getPythonVenvPath(): Promise<string | undefined> {
        if (process.env.VURA_PYTHON_VENV_PATH) {
            return process.env.VURA_PYTHON_VENV_PATH;
        }
        if (this.configMap['vura.python.venvPath']) {
            return this.configMap['vura.python.venvPath'];
        }
        const store = await this.loadConfigStore();
        if (store['vura.python.venvPath']) {
            return store['vura.python.venvPath'];
        }
        return path.join(this.storagePath, 'venv');
    }

    public async setPythonVenvPath(venvPath: string): Promise<void> {
        const store = await this.loadConfigStore();
        store['vura.python.venvPath'] = venvPath;
        await this.saveConfigStore(store);
    }

    public async setConfigValue(key: string, value: any): Promise<void> {
        const store = await this.loadConfigStore();
        // CLI input always arrives as a string. Parse it as JSON when possible so
        // typed values (numbers, booleans, arrays) round-trip correctly instead of
        // being stored as a literal string — e.g. "false" is truthy in JS, so a
        // boolean config stored as the string "false" would silently misbehave.
        // Falls back to the raw string for plain values like a filesystem path.
        try {
            store[key] = JSON.parse(value);
        } catch {
            store[key] = value;
        }
        this.configMap = store;
        await this.saveConfigStore(store);
    }

    public async getConfigValue(key: string): Promise<any> {
        const store = await this.loadConfigStore();
        return store[key];
    }

    public async listConfigValues(): Promise<Record<string, any>> {
        return this.loadConfigStore();
    }

    public async unsetConfigValue(key: string): Promise<boolean> {
        const store = await this.loadConfigStore();
        if (!(key in store)) return false;
        delete store[key];
        this.configMap = store;
        await this.saveConfigStore(store);
        return true;
    }

    public async setMapping(variable: string, targetPath: string): Promise<void> {
        const { ContextManager } = require('./services/contextManager');
        await ContextManager.getInstance().setMapping(this, variable, targetPath);
    }

    // --- Generic secret storage (for Add-ons via BaseAdapter) ---

    private async loadSecretsStore(): Promise<Record<string, string>> {
        try {
            const data = await fs.readFile(this.secretsStorePath, 'utf8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    private async saveSecretsStore(store: Record<string, string>): Promise<void> {
        await fs.mkdir(path.dirname(this.secretsStorePath), { recursive: true });
        await fs.writeFile(this.secretsStorePath, JSON.stringify(store, null, 2), 'utf8');
    }

    public async getSecret(key: string): Promise<string | undefined> {
        const store = await this.loadSecretsStore();
        return store[key];
    }

    public async setSecret(key: string, value: string): Promise<void> {
        const store = await this.loadSecretsStore();
        store[key] = value;
        await this.saveSecretsStore(store);
    }

    public async deleteSecret(key: string): Promise<void> {
        const store = await this.loadSecretsStore();
        delete store[key];
        await this.saveSecretsStore(store);
    }

    // --- Local analytics engine access (for Add-ons) ---

    public async runLocalQuery(sql: string): Promise<any[]> {
        const duckDb = await DuckDbManager.getInstance(this);
        return duckDb.runQuery(sql);
    }

    // --- Credential Store Management ---

    public async loadCredentialsStore(): Promise<Record<string, { profile: SqlProfile, secret: string }>> {
        try {
            const data = await fs.readFile(this.credentialsStorePath, 'utf8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    public async saveCredentialsStore(store: Record<string, { profile: SqlProfile, secret: string }>): Promise<void> {
        await fs.mkdir(path.dirname(this.credentialsStorePath), { recursive: true });
        await fs.writeFile(this.credentialsStorePath, JSON.stringify(store, null, 2), 'utf8');
    }

    // --- Generic Connection Profile Store Management ---

    public async loadConnectionsStore(): Promise<Record<string, ConnectionProfile>> {
        try {
            const data = await fs.readFile(this.connectionsStorePath, 'utf8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    public async saveConnectionsStore(store: Record<string, ConnectionProfile>): Promise<void> {
        await fs.mkdir(path.dirname(this.connectionsStorePath), { recursive: true });
        await fs.writeFile(this.connectionsStorePath, JSON.stringify(store, null, 2), 'utf8');
    }
}
