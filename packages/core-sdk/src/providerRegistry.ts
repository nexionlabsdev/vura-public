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

    public getAllProviders(): IVuraProvider[] {
        return Array.from(this.providers.values());
    }

    public getProviderForCommand(command: string): IVuraProvider | undefined {
        for (const provider of this.providers.values()) {
            if (provider.getCommands().includes(command)) {
                return provider;
            }
        }
        return undefined;
    }
}
