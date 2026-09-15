import * as vscode from 'vscode';
import { ProviderRegistry } from '@vura-data-os/core-sdk';

export type AddonTag = 'Official' | 'Community' | 'Driver';

export interface AddonCatalogEntry {
    /** VS Code extension id (publisher.name) this add-on ships as. */
    extensionId: string;
    displayName: string;
    kind: string;
    description: string;
    tags: AddonTag[];
}

/**
 * Known first-party connector Add-ons. Each ships as its own installable VS Code
 * extension (see packages/connectors/*) that, once activated, calls back into
 * core-extension's exported registerProvider() — there's no dynamic npm-style
 * plugin loader today, so this list has to be hand-maintained until the SDK
 * grows real marketplace metadata (see IVuraProvider in core-sdk).
 */
export const ADDON_CATALOG: AddonCatalogEntry[] = [
    { extensionId: 'nexionlabs.vura-dataverse', displayName: 'Microsoft Dataverse', kind: 'dataverse', description: 'Sync tables to and from a Microsoft Dataverse environment.', tags: ['Official', 'Driver'] },
    { extensionId: 'nexionlabs.vura-sharepoint', displayName: 'SharePoint', kind: 'sharepoint', description: 'Sync SharePoint Lists, import/export files from a document library.', tags: ['Official', 'Driver'] },
    { extensionId: 'nexionlabs.vura-onedrive', displayName: 'OneDrive', kind: 'onedrive', description: "Import/export files from a specific user's OneDrive.", tags: ['Official', 'Driver'] },
    { extensionId: 'nexionlabs.vura-googledrive', displayName: 'Google Drive', kind: 'googledrive', description: 'Import/export files from Google Drive.', tags: ['Official', 'Driver'] },
    { extensionId: 'nexionlabs.vura-s3', displayName: 'Amazon S3', kind: 's3', description: 'Import/export objects from an Amazon S3 bucket.', tags: ['Official', 'Driver'] },
    { extensionId: 'nexionlabs.vura-local', displayName: 'Local / Mapped Folder', kind: 'local', description: 'Import/export files from a local folder or mapped/mounted drive.', tags: ['Official', 'Driver'] }
];

/** A curated, notebook-relevant set of pip-installable Python libraries — not a general-purpose pip GUI. */
export const PYTHON_PACKAGE_CATALOG: Array<{ name: string; description: string }> = [
    { name: 'openpyxl', description: 'Read/write Excel .xlsx files from Python cells.' },
    { name: 'requests', description: 'Simple HTTP calls from Python cells.' },
    { name: 'xlrd', description: 'Read legacy Excel .xls files.' },
    { name: 'lxml', description: 'Fast XML/HTML parsing.' }
];

export interface AddonStatus extends AddonCatalogEntry {
    installed: boolean;
    /** Only meaningful when installed — whether the host currently routes commands/kind-lookups to it. */
    enabled: boolean;
    /** Whether this add-on has actually called registerProvider() yet (vs. just being installed but not activated). */
    registered: boolean;
    /** The registered provider id backing this entry, if any — needed to call setProviderEnabled(). */
    providerId?: string;
}

/**
 * Connector extensions activate lazily — vura-dataverse's own package.json only
 * lists `onNotebook:vura-notebook` / `onLanguage:vura-terminal` / `onLanguage:shellscript`
 * as activation events, so `vscode.extensions.getExtension(id)` can be truthy (the
 * extension is installed) for a long time before it's ever active and has actually
 * called back into `registerProvider()`. Without forcing activation here, the Hub
 * would report every installed-but-not-yet-opened connector as unavailable in
 * Connectors even though Add-ons correctly shows it installed — exactly the
 * inconsistency this fixes. `ext.activate()` is idempotent/cached by VS Code, so
 * calling this on every Hub refresh is cheap once an extension is already active.
 */
export async function ensureCatalogExtensionsActivated(): Promise<void> {
    await Promise.all(ADDON_CATALOG.map(async entry => {
        const ext = vscode.extensions.getExtension(entry.extensionId);
        if (ext && !ext.isActive) {
            try {
                await ext.activate();
            } catch (err) {
                console.error(`Failed to activate add-on extension ${entry.extensionId}:`, err);
            }
        }
    }));
}

export async function getAddonStatuses(): Promise<AddonStatus[]> {
    await ensureCatalogExtensionsActivated();

    const registry = ProviderRegistry.getInstance();

    return ADDON_CATALOG.map(entry => {
        const ext = vscode.extensions.getExtension(entry.extensionId);
        // Provider ids used by registerProvider() calls aren't required to match the
        // extension id 1:1 today, so registered/enabled are best-effort: an add-on is
        // considered "registered" if any currently-registered provider declares this
        // catalog entry's connector kind.
        const matchingProviderId = registry.getAllProviderIds().find(id => {
            const provider = registry.getProvider(id);
            return provider?.getConnectorKind?.() === entry.kind;
        });
        return {
            ...entry,
            installed: !!ext,
            registered: !!matchingProviderId,
            // An installed-but-not-yet-registered add-on is neither "enabled" nor "disabled"
            // in any meaningful sense — default to false so the UI doesn't claim readiness
            // it can't back up (registered is the flag that actually distinguishes this case).
            enabled: matchingProviderId ? registry.isProviderEnabled(matchingProviderId) : false,
            providerId: matchingProviderId
        };
    });
}
