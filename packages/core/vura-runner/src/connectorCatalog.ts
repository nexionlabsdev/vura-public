import { ConnectionField, ICellLogger, IVuraEnvironment, IVuraProvider, ProviderRegistry } from '@vura-data-os/core-sdk';
import { loadPlugins } from './pluginLoader';

/**
 * Connector catalog (ECR-4): what connector Add-ons an engine can offer, and whether a connection to one
 * works — WITHOUT running a notebook. Hosts (an enterprise worker, a CLI) use it to render connection
 * forms, to refuse a workflow whose plugin is not installed before it runs, and to test a profile.
 *
 * It only uses what a provider already declares (`getConnectorKind`, `getConnectionFields`,
 * `testConnection`); nothing about the providers changes.
 */
export interface ConnectorDescriptor {
    /** The Add-on package that provides it (what a notebook lists in `requiredPlugins`). */
    plugin: string;
    /** The ConnectionProfile kind the Add-on manages; null when it declares none. */
    kind: string | null;
    /** Magic commands the Add-on handles. */
    commands: string[];
    /** Form fields for a connection of this kind. At most one has `secret: true` (its value is never part of the config). */
    fields: ConnectionField[];
    /** Whether `testConnector` can probe a connection of this kind. */
    testable: boolean;
}

export interface ConnectorCatalog {
    connectors: ConnectorDescriptor[];
    /** Plugins that were asked for and could not be loaded, with the reason. */
    unavailable: { plugin: string; reason: string }[];
}

export interface ConnectionTestResult {
    /** False when the connector kind declares no test: `success` is then meaningless, never a guess. */
    supported: boolean;
    success: boolean;
    message: string;
}

/** A logger that keeps what plugin loading reports, so a failed load can be explained. */
function collectingLogger(): { logger: ICellLogger; lines: string[] } {
    const lines: string[] = [];
    const logger: ICellLogger = {
        logText: async (t) => { lines.push(t); },
        logError: async (e) => { lines.push(String(e instanceof Error ? e.message : e)); },
        logHtml: async () => undefined, logJson: async () => undefined, replaceOutput: async () => undefined,
        logMultiple: async () => undefined, clearOutput: async () => undefined,
    };
    return { logger, lines };
}

function describe(plugin: string, p: IVuraProvider): ConnectorDescriptor {
    return {
        plugin,
        kind: p.getConnectorKind ? String(p.getConnectorKind()) : null,
        commands: safe(() => p.getCommands(), []),
        fields: p.getConnectionFields ? safe(() => p.getConnectionFields!(), []) : [],
        testable: typeof p.testConnection === 'function',
    };
}

function safe<T>(f: () => T, fallback: T): T {
    try { return f(); } catch { return fallback; }
}

/**
 * Loads the named Add-on packages (those already loaded are reused) and describes them. A plugin that cannot be
 * loaded is reported in `unavailable`, never silently dropped.
 */
export async function getConnectorCatalog(plugins: string[], env: IVuraEnvironment): Promise<ConnectorCatalog> {
    const registry = ProviderRegistry.getInstance();
    const { logger, lines } = collectingLogger();
    const unique = Array.from(new Set(plugins));
    await loadPlugins(unique, env, logger);
    const out: ConnectorCatalog = { connectors: [], unavailable: [] };
    for (const name of unique) {
        const p = registry.getProvider(name);
        if (p) out.connectors.push(describe(name, p));
        else out.unavailable.push({ plugin: name, reason: lines.find((l) => l.includes(`"${name}"`))?.replace(/^Warning: /, '') ?? 'the plugin could not be loaded' });
    }
    return out;
}

/**
 * Probes one connection with the Add-on's own `testConnection`. `config` is the profile's non-secret settings and
 * `secret` its single secret value (kept in memory only; never logged). A connector without a test answers
 * `supported: false`. The probe is bounded by `timeoutMs`.
 */
export async function testConnector(plugin: string, config: Record<string, any>, secret: string | undefined, env: IVuraEnvironment, timeoutMs = 20000): Promise<ConnectionTestResult> {
    const registry = ProviderRegistry.getInstance();
    const { logger } = collectingLogger();
    await loadPlugins([plugin], env, logger);
    const p = registry.getProvider(plugin);
    if (!p) return { supported: true, success: false, message: `the plugin "${plugin}" is not available in this engine` };
    if (typeof p.testConnection !== 'function') return { supported: false, success: false, message: 'this connector does not offer a connection test' };
    let timer: NodeJS.Timeout | undefined;
    try {
        const r = await Promise.race([
            p.testConnection(config, secret),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`the test did not finish within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); }),
        ]);
        return { supported: true, success: !!r.success, message: String(r.message ?? '') };
    } catch (e: any) {
        return { supported: true, success: false, message: String(e?.message ?? e) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
