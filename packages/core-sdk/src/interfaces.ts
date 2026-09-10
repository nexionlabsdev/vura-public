// ─── Host-agnostic execution primitives ─────────────────────────────────────
// Shared between the VS Code extension (core-extension), the standalone CLI
// (vura-runner), and any add-on (like vura-dataverse) that needs to run the
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
    storagePath: string;
    notebookDir: string;
    notebookId: string;
    extensionPath: string;

    getConfig<T>(key: string, defaultValue: T): T;

    getProfile(profileId: string): Promise<SqlProfile | undefined>;
    getProfileSecret(profileId: string): Promise<string | undefined>;

    getSecret(key: string): Promise<string | undefined>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;

    runLocalQuery(sql: string): Promise<any[]>;

    getPythonVenvPath(): Promise<string | undefined>;
    setPythonVenvPath(path: string): Promise<void>;

    setMapping(variable: string, path: string): Promise<void>;
}

// ─── Add-on contract ─────────────────────────────────────────────────────────

export interface IVuraProvider {
    activate(env: IVuraEnvironment): Promise<void>;
    getCommands(): string[];
    getSettings(): any;
    handleCommand(
        commandRoot: string,
        cell: FlownbCell,
        logger: ICellLogger,
        env: IVuraEnvironment,
        commandLine: string
    ): Promise<void>;
}

export interface IConnectionAdapter {
    connect(): Promise<void>;
    validate(): Promise<boolean>;
    sync(args: any): Promise<any>;
}

// ─── Phase 9c: Optional SDK hook for host-specific UI ─────────────────────────

export interface UIAction {
    id: string;
    label: string;
    kind: 'quickpick' | 'input' | 'button';
    options?: () => Promise<string[]>;
    onSelect: (value: string, cell: FlownbCell) => Promise<void>;
}

export interface IUIActionProvider {
    getUIActions(cell: FlownbCell): UIAction[];
}
