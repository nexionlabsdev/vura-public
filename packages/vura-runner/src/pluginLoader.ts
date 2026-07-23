import { IVuraProvider, IVuraEnvironment, ICellLogger, ProviderRegistry } from '@vura-data-os/core-sdk';

/**
 * Loads and registers Add-on plugin packages by name (e.g.
 * "@vura-data-os/vura-dataverse-runner-plugin"). Each package's default export must be
 * a class implementing IVuraProvider. Mirrors what core-extension's
 * `registerProvider` export does for VS Code Add-ons, but discovered via an
 * explicit list instead of the VS Code extension host.
 *
 * A plugin that fails to load only logs a warning — it must not abort the
 * rest of the notebook run, since the failure only matters if one of its
 * magic commands actually gets used.
 */
export async function loadPlugins(
    pluginNames: string[],
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    const registry = ProviderRegistry.getInstance();

    for (const name of pluginNames) {
        if (registry.getProvider(name)) continue; // already loaded

        try {
            const mod = require(name);
            const ProviderClass = mod.default || mod;
            const provider: IVuraProvider = new ProviderClass();
            await registry.registerProvider(name, provider, env);
        } catch (err: any) {
            await logger.logText(
                `Warning: failed to load plugin "${name}" (${err.message}). ` +
                `Its magic commands will fall back to shell execution. Install it with: npm install -g ${name}`
            );
        }
    }
}
