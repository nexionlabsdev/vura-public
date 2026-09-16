import { IVuraProvider, IVuraEnvironment } from './interfaces';

/**
 * Tracks registered Add-ons and routes magic commands to whichever one
 * declared it via getCommands(). Shared by both hosts: core-extension
 * (VS Code) registers providers as extensions activate; vura-runner (CLI)
 * registers providers loaded via its plugin loader.
 */
export class ProviderRegistry {
    private static instance: ProviderRegistry;
    private providers: Map<string, IVuraProvider> = new Map();
    private disabledIds: Set<string> = new Set();

    private constructor() {}

    public static getInstance(): ProviderRegistry {
        if (!ProviderRegistry.instance) {
            ProviderRegistry.instance = new ProviderRegistry();
        }
        return ProviderRegistry.instance;
    }

    public async registerProvider(id: string, provider: IVuraProvider, env: IVuraEnvironment): Promise<void> {
        this.providers.set(id, provider);
        try {
            await provider.activate(env);
        } catch (err: any) {
            console.error(`Failed to activate provider ${id}:`, err);
        }
    }

    public getProvider(id: string): IVuraProvider | undefined {
        return this.providers.get(id);
    }

    /** Every registered provider, excluding any the host has disabled via setProviderEnabled(). */
    public getAllProviders(): IVuraProvider[] {
        return Array.from(this.providers.entries())
            .filter(([id]) => !this.disabledIds.has(id))
            .map(([, provider]) => provider);
    }

    public getProviderForCommand(command: string): IVuraProvider | undefined {
        for (const [id, provider] of this.providers.entries()) {
            if (this.disabledIds.has(id)) continue;
            if (provider.getCommands().includes(command)) {
                return provider;
            }
        }
        return undefined;
    }

    /** Registered provider ids, in registration order — including disabled ones. */
    public getAllProviderIds(): string[] {
        return Array.from(this.providers.keys());
    }

    public isProviderEnabled(id: string): boolean {
        return !this.disabledIds.has(id);
    }

    /**
     * Toggle a provider on/off without unregistering it. A disabled provider stays
     * activated (its magic-command handlers just stop being routed to, and its
     * connector kind stops showing up in getAllProviders()-driven UI) — this is a
     * UI-level "hide" the host can persist (e.g. in ExtensionContext.globalState) and
     * re-apply on every activation via this call, not a real uninstall.
     */
    public setProviderEnabled(id: string, enabled: boolean): void {
        if (enabled) {
            this.disabledIds.delete(id);
        } else {
            this.disabledIds.add(id);
        }
    }
}
