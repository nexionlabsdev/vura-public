import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/** Config key for the optional user-chosen scratch directory; empty means "use the default per-session storage path". */
export const CACHE_DIRECTORY_CONFIG_KEY = 'vura.cache.directory';

export function getConfiguredCacheDirectory(defaultStoragePath: string): string {
    const configured = vscode.workspace.getConfiguration().get<string>(CACHE_DIRECTORY_CONFIG_KEY, '');
    return configured && configured.trim().length > 0 ? configured : defaultStoragePath;
}

async function walkSize(dir: string): Promise<number> {
    let total = 0;
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await walkSize(full);
        } else if (entry.isFile()) {
            try {
                const stat = await fs.stat(full);
                total += stat.size;
            } catch {}
        }
    }
    return total;
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface StorageStatus {
    directory: string;
    usedBytes: number;
    usedHuman: string;
    isCustom: boolean;
}

export async function getStorageStatus(defaultStoragePath: string): Promise<StorageStatus> {
    const directory = getConfiguredCacheDirectory(defaultStoragePath);
    const usedBytes = await walkSize(directory);
    return {
        directory,
        usedBytes,
        usedHuman: formatBytes(usedBytes),
        isCustom: directory !== defaultStoragePath
    };
}

/**
 * Deletes the *contents* of `directory` (not the directory itself) — active DuckDB/session
 * files that are currently open may fail to delete on some platforms; those failures are
 * swallowed per-entry so a locked file doesn't abort the whole purge.
 */
export async function purgeDirectoryContents(directory: string): Promise<{ deletedCount: number; skippedCount: number }> {
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return { deletedCount: 0, skippedCount: 0 };
    }
    let deletedCount = 0;
    let skippedCount = 0;
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        try {
            await fs.rm(full, { recursive: true, force: true });
            deletedCount++;
        } catch {
            skippedCount++;
        }
    }
    return { deletedCount, skippedCount };
}
