import { IVuraEnvironment } from './interfaces';

/**
 * Base class for Add-ons. Providers are constructed by their host before an
 * IVuraEnvironment exists (VS Code activates the extension, the CLI loads the
 * plugin package) — the environment only becomes available at activate(),
 * so it's captured there rather than via the constructor. Subclasses that
 * override activate() must call super.activate(env).
 */
export abstract class BaseAdapter {
    protected env!: IVuraEnvironment;

    async activate(env: IVuraEnvironment): Promise<void> {
        this.env = env;
    }

    /**
     * Store a secret securely via the host's secret storage.
     */
    protected async storeSecret(key: string, value: string): Promise<void> {
        await this.env.setSecret(key, value);
    }

    /**
     * Retrieve a securely stored secret.
     */
    protected async getSecret(key: string): Promise<string | undefined> {
        return await this.env.getSecret(key);
    }

    /**
     * Delete a securely stored secret.
     */
    protected async deleteSecret(key: string): Promise<void> {
        await this.env.deleteSecret(key);
    }
}
