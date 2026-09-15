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

// ─── Generic connection profiles (Phase: multi-provider connections) ────────
// SqlProfile above stays as the 'sql' kind's on-disk shape for backward
// compatibility with stores that already have SQL profiles saved. Every other
// connector (Dataverse, SharePoint, OneDrive, Google Drive, S3, local folder,
// and any future Add-on) describes its connection as a ConnectionProfile
// instead of overloading SqlProfile's fields.

export type ConnectorKind = 'sql' | 'dataverse' | 'sharepoint' | 'onedrive' | 'googledrive' | 's3' | 'local' | string;

export interface ConnectionProfile<TConfig = Record<string, any>> {
    id: string;
    name: string;
    kind: ConnectorKind;
    config: TConfig; // kind-specific, non-secret fields (tenantId, bucket, basePath, ...)
}

export interface StorageEntry {
    name: string;
    path: string;
    isFolder: boolean;
    size?: number;
    modifiedAt?: string;
}

/** Implemented by Add-ons that can import/export files against a remote or local store. */
export interface IStorageProvider {
    listFiles(connectionId: string, folderPath: string): Promise<StorageEntry[]>;
    readFile(connectionId: string, filePath: string): Promise<Buffer>;
    writeFile(connectionId: string, filePath: string, content: Buffer, mime?: string): Promise<void>;
    deleteFile?(connectionId: string, filePath: string): Promise<void>;
}

export interface ConnectionField {
    key: string;
    label: string;
    /** 'folder' renders as a read-only path box with a native "Browse..." folder picker
     *  instead of a free-text box — use it for any field that names a local directory
     *  (e.g. a local-connector base path), so the value is always a real, valid path. */
    type: 'text' | 'password' | 'select' | 'number' | 'folder';
    /** Whether the field must be filled in before the connection can be saved. */
    required?: boolean;
    /** Whether the value is stored in the secret store instead of the profile's plain config.
     *  At most one field per connector kind should set this — profile secrets are stored as a
     *  single raw string per connection id (env.getProfileSecret), not a structured payload. */
    secret?: boolean;
    options?: string[];
    placeholder?: string;
    default?: string;
    helpText?: string;
    /** Only show/require this field when another field currently has one of these values
     *  (e.g. an S3 access key is only relevant when authMode === 'AccessKey'). */
    showWhen?: { field: string; equals: string | string[] };
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

    getConnectionProfile(profileId: string): Promise<ConnectionProfile | undefined>;
    listConnectionProfiles(kind?: ConnectorKind): Promise<ConnectionProfile[]>;

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
    /** Declares the ConnectionProfile kind this Add-on manages, so hosts can build a
     *  generic connection picker/settings UI without per-connector hardcoding. */
    getConnectorKind?(): ConnectorKind;
    /** Form fields the generic connection settings UI should render for this Add-on's profiles. */
    getConnectionFields?(): ConnectionField[];
    /** Optional lightweight ping/metadata-probe a generic connection UI can invoke before
     *  saving a profile, so "Test Connection" isn't hardcoded to the 'sql' kind. Kinds that
     *  don't implement this should be treated as "test not supported" by the host UI. */
    testConnection?(config: Record<string, any>, secret?: string): Promise<{ success: boolean; message: string }>;
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
