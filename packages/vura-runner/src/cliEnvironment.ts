import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { IVuraEnvironment, SqlProfile } from './interfaces';
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

    constructor(notebookDir: string, envFilePath?: string) {
        this.notebookDir = path.resolve(notebookDir);
        this.storagePath = path.join(process.cwd(), '.vura', 'storage');
        this.extensionPath = path.resolve(__dirname, '..'); // package root

        const crypto = require('crypto');
        this.notebookId = crypto.createHash('md5').update(this.notebookDir).digest('hex');

        // Load dotenv if specified
        if (envFilePath) {
            require('dotenv').config({ path: path.resolve(envFilePath) });
        } else {
            require('dotenv').config();
        }

        const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
        const vuraDir = path.join(homeDir, '.vura');
        this.credentialsStorePath = path.join(vuraDir, 'credentials.json');
        this.configStorePath = path.join(vuraDir, 'config.json');
        this.secretsStorePath = path.join(vuraDir, 'secrets.json');

        // getConfig() is synchronous (to match VsCodeEnvironment's config API), so the
        // persisted store is loaded eagerly here rather than lazily via loadConfigStore().
        try {
            this.configMap = JSON.parse(fsSync.readFileSync(this.configStorePath, 'utf8'));
        } catch {
            this.configMap = {};
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
        return store[profileId]?.secret;
    }

    public async getPythonVenvPath(): Promise<string | undefined> {
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
        await this.saveConfigStore(store);
        return true;
    }

    public async setMapping(variable: string, targetPath: string): Promise<void> {
        // We could implement mapping here if needed
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
}
