// ─── Host-agnostic execution primitives ─────────────────────────────────────
// Shared between the VS Code extension (core-extension), the standalone CLI
// (vura-runner), and any add-on (like vura-dataverse-adapter) that needs to run the
// same code against either host.

export type AuthMode = 'ServicePrincipal' | 'DeviceCode' | 'SqlLogin' | 'WindowsAuth';

export interface SqlProfile {
    id: string; // Unique ID (usually lowercase name with dashes)
    name: string;
    authMode: AuthMode;
    server: string;
    database: string;
    port: number;
    clientId?: string;
    tenantId?: string;
    username?: string;
    domain?: string;
}

export interface RawOutputItem {
    mime: string;
    data: string; // base64-encoded
}

export interface RawOutput {
    items: RawOutputItem[];
}

/** A single notebook cell, independent of the host's own cell representation. */
export interface FlownbCell {
    language: string;
    value: string;
    kind: number; // 1 = markup, 2 = code
    // metadata supports optional execution control fields:
    // - label: string       — stable identifier for this cell, used in runWhen references
    // - group: string       — group name this cell belongs to
    // - runWhen: string     — expr-eval expression evaluated before execution
    metadata?: { [key: string]: any };
    outputs?: RawOutput[];
}

/** Output sink a cell (or a provider handling a magic command) writes to. */
export interface ICellLogger {
    logText(text: string): Promise<void>;
    logError(error: string | Error): Promise<void>;
    logHtml(html: string): Promise<void>;
    logJson(json: any): Promise<void>;
    replaceOutput(html: string): Promise<void>;
    logMultiple(items: { mime: string, data: any }[]): Promise<void>;
    clearOutput(): Promise<void>;
}

/**
 * Everything a cell handler or Add-on needs from its host (VS Code or the
 * standalone CLI), without depending on either one directly.
 */
export interface IVuraEnvironment {
    // Filesystem / Workspace Context
    storagePath: string; // The root directory to store duckdb files, parquet, sidecars
    notebookDir: string; // The directory where the .flownb file is located
    notebookId: string;  // Unique identifier for the notebook to isolate duckdb instances
    extensionPath: string; // The path to the runner/extension installation (to find assets)

    // Configuration
    getConfig<T>(key: string, defaultValue: T): T;

    // Connections and Secrets
    getProfile(profileId: string): Promise<SqlProfile | undefined>;
    getProfileSecret(profileId: string): Promise<string | undefined>;

    // Generic secret storage for Add-ons (VS Code: SecretStorage; CLI: local secret store)
    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;

    // Local analytics engine access, for Add-ons that need to read/write the
    // shared DuckDB instance (e.g. to sync a local table to an external system).
    runLocalQuery(sql: string): Promise<any[]>;

    // Execution / Process Context
    getPythonVenvPath(): Promise<string | undefined>;
    setPythonVenvPath(path: string): Promise<void>;

    // Communication mappings
    setMapping(variable: string, path: string): Promise<void>;
}

// ─── Add-on contract ─────────────────────────────────────────────────────────

export interface IVuraProvider {
    /**
     * Called once when the provider is registered with its host.
     */
    activate(env: IVuraEnvironment): Promise<void>;

    /**
     * Gets the custom terminal commands handled by this provider (e.g. ['!sync_dataverse']).
     */
    getCommands(): string[];

    /**
     * Gets the custom configuration settings contributed by this provider.
     */
    getSettings(): any;

    /**
     * Handle one of this provider's magic commands for a given cell.
     */
    handleCommand(
        commandRoot: string,
        cell: FlownbCell,
        logger: ICellLogger,
        env: IVuraEnvironment,
        commandLine: string
    ): Promise<void>;
}

export interface IConnectionAdapter {
    /**
     * Establish a connection.
     */
    connect(): Promise<void>;

    /**
     * Validate the connection.
     */
    validate(): Promise<boolean>;

    /**
     * Execute a synchronization process.
     */
    sync(args: any): Promise<any>;
}
