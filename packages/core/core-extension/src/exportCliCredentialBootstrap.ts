import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ConnectionProfile, ConnectionField } from '@vura-data-os/core-sdk';
import { ConnectionManager } from './connectionManager';
import { getConnectorKindDescriptors } from './connectionsConfigViewProvider';

const TARGET_FILES = [
    'vura-import-profiles.sh',
    'vura-import-profiles.ps1',
    'set-vura-secrets.sh',
    'set-vura-secrets.ps1'
] as const;

/** Matches CliEnvironment.getProfileSecret's env-var transform round-trip. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ProfileConfigShape {
    authMode?: string;
    server?: string;
    database?: string;
    username?: string;
    clientId?: string;
    tenantId?: string;
    domain?: string;
    port?: number | string;
}

function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ps1Quote(value: string): string {
    const escaped = value.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    return `"${escaped}"`;
}

function secretValueNote(authMode: string): string {
    if (authMode === 'SqlLogin') return 'raw password string, not JSON';
    if (authMode === 'ServicePrincipal') return 'raw clientSecret string, not JSON';
    return 'raw string value';
}

function envVarName(profileId: string): string {
    return `VURA_PROFILE_SECRET_${profileId.toUpperCase().replace(/-/g, '_')}`;
}

/** vura-runner's `credentials add` only understands legacy SqlProfile shape (server/database/authMode). */
function buildSqlImportLine(profile: ConnectionProfile, quote: (v: string) => string): string {
    const cfg = (profile.config || {}) as ProfileConfigShape;
    const authMode = cfg.authMode || '';
    const server = cfg.server || '';
    const database = cfg.database || '';

    const args = ['vura-runner', 'credentials', 'add', quote(profile.id), quote(server), quote(database), quote(authMode)];

    const warnings: string[] = [];
    if (authMode === 'ServicePrincipal') {
        if (!cfg.clientId) warnings.push('clientId');
        if (!cfg.tenantId) warnings.push('tenantId');
    } else if (authMode === 'SqlLogin' || authMode === 'WindowsAuth') {
        if (!cfg.username) warnings.push('username');
    }

    if (cfg.username) args.push('--username', quote(cfg.username));
    if (cfg.clientId) args.push('--client-id', quote(cfg.clientId));
    if (cfg.tenantId) args.push('--tenant-id', quote(cfg.tenantId));
    if (cfg.port !== undefined && cfg.port !== null && cfg.port !== '') args.push('--port', quote(String(cfg.port)));
    args.push('--secret', quote(''));

    const line = args.join(' ');
    return warnings.length > 0 ? `${line}  # WARNING: missing ${warnings.join(', ')}` : line;
}

/**
 * Every non-'sql' kind (Dataverse, SharePoint, OneDrive, Google Drive, S3, local, ...) has its
 * own field schema instead of server/database/authMode, and goes through vura-runner's generic
 * `connections add <id> <kind> --field k=v ...` command instead of `credentials add`.
 */
function buildGenericImportLine(profile: ConnectionProfile, quote: (v: string) => string, fields: ConnectionField[]): string {
    const cfg = (profile.config || {}) as Record<string, unknown>;
    const args = ['vura-runner', 'connections', 'add', quote(profile.id), quote(profile.kind)];

    const nonSecretFields = fields.filter(f => !f.secret);
    const warnings: string[] = [];
    const emittedKeys = new Set<string>();

    for (const field of nonSecretFields) {
        const value = cfg[field.key];
        if (value === undefined || value === null || value === '') {
            if (field.required) warnings.push(field.key);
            continue;
        }
        args.push('--field', quote(`${field.key}=${String(value)}`));
        emittedKeys.add(field.key);
    }

    // Field schema may be empty (provider Add-on not installed in this VS Code) or incomplete —
    // fall back to whatever non-secret keys the profile actually has so nothing is silently dropped.
    for (const [key, value] of Object.entries(cfg)) {
        if (emittedKeys.has(key) || value === undefined || value === null || value === '') continue;
        args.push('--field', quote(`${key}=${String(value)}`));
    }

    args.push('--secret', quote(''));

    const line = args.join(' ');
    return warnings.length > 0 ? `${line}  # WARNING: missing ${warnings.join(', ')}` : line;
}

function buildImportLine(profile: ConnectionProfile, quote: (v: string) => string, kindFields: Map<string, ConnectionField[]>): string {
    if (profile.kind === 'sql') {
        return buildSqlImportLine(profile, quote);
    }
    return buildGenericImportLine(profile, quote, kindFields.get(profile.kind) || []);
}

function buildSecretsLines(profile: ConnectionProfile, invalidId: boolean, kindFields: Map<string, ConnectionField[]>): { sh: string; ps1: string } {
    if (invalidId) {
        const comment = `# Skipped profile "${profile.id}": id contains characters outside [A-Za-z0-9_-]; rename the profile before exporting.`;
        return { sh: comment, ps1: comment };
    }

    const envVar = envVarName(profile.id);
    const cfg = (profile.config || {}) as ProfileConfigShape;

    if (profile.kind === 'sql' && cfg.authMode === 'DeviceCode') {
        const comment = `# ${envVar}: profile "${profile.id}" (DeviceCode) is an interactive browser login and cannot be satisfied by a static secret — not usable from vura-runner batch/CI/serve execution.`;
        return { sh: comment, ps1: comment };
    }

    let label: string;
    let note: string;
    if (profile.kind === 'sql') {
        label = cfg.authMode || '';
        note = secretValueNote(label);
    } else {
        label = profile.kind;
        const secretField = (kindFields.get(profile.kind) || []).find(f => f.secret);
        note = secretField ? `raw ${secretField.label.toLowerCase()} string, not JSON` : 'raw string value, not JSON';
    }

    return {
        sh: `export ${envVar}=""   # ${label}: profile "${profile.id}" — ${note}`,
        ps1: `$env:${envVar} = ""   # ${label}: profile "${profile.id}" — ${note}`
    };
}

function buildImportScript(profiles: ConnectionProfile[], kind: 'sh' | 'ps1', kindFields: Map<string, ConnectionField[]>): string {
    const lines = profiles.map(p => buildImportLine(p, kind === 'sh' ? shQuote : ps1Quote, kindFields));

    if (kind === 'sh') {
        return [
            '#!/usr/bin/env bash',
            '# Generated by VURA: Export CLI Credential Bootstrap',
            '#',
            '# Imports non-secret connection profile shape into the vura-runner CLI\'s local',
            '# stores: `vura-runner credentials add` for SQL/Azure SQL profiles, and',
            '# `vura-runner connections add` for every other connector kind (Dataverse,',
            '# SharePoint, OneDrive, Google Drive, S3, local, ...). Every profile below is',
            '# added with a placeholder secret (--secret "") — fill in real values with',
            '# set-vura-secrets.sh before running a notebook that needs them.',
            '#',
            '# You may need to make this script executable: chmod +x vura-import-profiles.sh',
            'set -e',
            '',
            ...lines,
            ''
        ].join('\n');
    }

    return [
        '# Generated by VURA: Export CLI Credential Bootstrap',
        '#',
        '# Imports non-secret connection profile shape into the vura-runner CLI\'s local',
        '# stores: `vura-runner credentials add` for SQL/Azure SQL profiles, and',
        '# `vura-runner connections add` for every other connector kind (Dataverse,',
        '# SharePoint, OneDrive, Google Drive, S3, local, ...). Every profile below is',
        '# added with a placeholder secret (--secret "") — fill in real values with',
        '# set-vura-secrets.ps1 before running a notebook that needs them.',
        '$ErrorActionPreference = "Stop"',
        '',
        ...lines,
        ''
    ].join('\r\n');
}

function buildSecretsScript(
    validProfiles: ConnectionProfile[],
    invalidProfiles: ConnectionProfile[],
    kind: 'sh' | 'ps1',
    kindFields: Map<string, ConnectionField[]>
): string {
    const lines = [
        ...validProfiles.map(p => buildSecretsLines(p, false, kindFields)[kind]),
        ...invalidProfiles.map(p => buildSecretsLines(p, true, kindFields)[kind])
    ];

    if (kind === 'sh') {
        return [
            '#!/usr/bin/env bash',
            '# Generated by VURA: Export CLI Credential Bootstrap',
            '#',
            '# IMPORTANT: this file must be SOURCED, not executed — running it as a',
            '# subprocess will not persist the env vars into your calling shell.',
            '#   source ./set-vura-secrets.sh',
            '#',
            '# Fill in real values before running. Do not commit this file once filled in.',
            '',
            ...lines,
            ''
        ].join('\n');
    }

    return [
        '# Generated by VURA: Export CLI Credential Bootstrap',
        '#',
        '# IMPORTANT: this file must be dot-sourced, not executed — running it as a',
        '# subprocess will not persist the env vars into your calling shell.',
        '#   . .\\set-vura-secrets.ps1',
        '#',
        '# Fill in real values before running. Do not commit this file once filled in.',
        '',
        ...lines,
        ''
    ].join('\r\n');
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function findGitignoreTarget(destDir: string): Promise<string | undefined> {
    const localGitignore = path.join(destDir, '.gitignore');
    if (await fileExists(localGitignore)) {
        return localGitignore;
    }
    let dir = destDir;
    while (true) {
        if (await fileExists(path.join(dir, '.git'))) {
            return localGitignore;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

async function offerGitignoreAppend(destDir: string): Promise<void> {
    const gitignorePath = await findGitignoreTarget(destDir);
    if (!gitignorePath) return;

    const entriesToAdd = ['set-vura-secrets.sh', 'set-vura-secrets.ps1'];
    let existingContent = '';
    if (await fileExists(gitignorePath)) {
        try {
            existingContent = await fs.readFile(gitignorePath, 'utf8');
        } catch {
            return;
        }
    }
    const existingLines = new Set(existingContent.split(/\r?\n/).map(l => l.trim()));
    const missing = entriesToAdd.filter(e => !existingLines.has(e));
    if (missing.length === 0) return;

    const choice = await vscode.window.showInformationMessage(
        `Add ${missing.join(' and ')} to .gitignore so real secrets aren't committed once filled in?`,
        'Add to .gitignore',
        'Skip'
    );
    if (choice !== 'Add to .gitignore') return;

    const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
    const appended = existingContent + separator + missing.join('\n') + '\n';
    try {
        await fs.writeFile(gitignorePath, appended, 'utf8');
    } catch (err) {
        vscode.window.showWarningMessage(`Could not update .gitignore: ${(err as Error).message}`);
    }
}

export async function exportCliCredentialBootstrap(context: vscode.ExtensionContext): Promise<void> {
    const allProfiles = ConnectionManager.getAllConnectionProfiles(context);
    if (allProfiles.length === 0) {
        vscode.window.showInformationMessage('No connection profiles found to export.');
        return;
    }

    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    const profiles: ConnectionProfile[] = [];
    for (const p of allProfiles) {
        if (seenIds.has(p.id)) {
            duplicateIds.push(p.id);
            continue;
        }
        seenIds.add(p.id);
        profiles.push(p);
    }

    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Export Folder'
    });
    if (!folders || folders.length === 0) {
        return;
    }
    const destDir = folders[0].fsPath;

    const existingTargets: string[] = [];
    for (const f of TARGET_FILES) {
        if (await fileExists(path.join(destDir, f))) {
            existingTargets.push(f);
        }
    }
    if (existingTargets.length > 0) {
        const choice = await vscode.window.showWarningMessage(
            `The following files already exist in the selected folder and will be overwritten: ${existingTargets.join(', ')}`,
            { modal: true },
            'Overwrite'
        );
        if (choice !== 'Overwrite') {
            return;
        }
    }

    const validIdProfiles: ConnectionProfile[] = [];
    const invalidIdProfiles: ConnectionProfile[] = [];
    for (const p of profiles) {
        if (SAFE_ID_PATTERN.test(p.id)) {
            validIdProfiles.push(p);
        } else {
            invalidIdProfiles.push(p);
        }
    }

    const kindFields = new Map<string, ConnectionField[]>();
    for (const descriptor of getConnectorKindDescriptors()) {
        kindFields.set(descriptor.kind, descriptor.fields);
    }

    const filesToWrite: Array<{ name: string; content: string }> = [
        { name: 'vura-import-profiles.sh', content: buildImportScript(profiles, 'sh', kindFields) },
        { name: 'vura-import-profiles.ps1', content: buildImportScript(profiles, 'ps1', kindFields) },
        { name: 'set-vura-secrets.sh', content: buildSecretsScript(validIdProfiles, invalidIdProfiles, 'sh', kindFields) },
        { name: 'set-vura-secrets.ps1', content: buildSecretsScript(validIdProfiles, invalidIdProfiles, 'ps1', kindFields) }
    ];

    const written: string[] = [];
    try {
        for (const f of filesToWrite) {
            const target = path.join(destDir, f.name);
            await fs.writeFile(target, f.content, 'utf8');
            written.push(f.name);
        }
    } catch (err) {
        for (const name of written) {
            try {
                await fs.unlink(path.join(destDir, name));
            } catch {
                // best-effort cleanup only
            }
        }
        vscode.window.showErrorMessage(`Failed to write CLI credential bootstrap files: ${(err as Error).message}`);
        return;
    }

    if (duplicateIds.length > 0) {
        vscode.window.showWarningMessage(
            `${duplicateIds.length} duplicate profile id(s) were skipped (first occurrence kept): ${duplicateIds.join(', ')}`
        );
    }
    if (invalidIdProfiles.length > 0) {
        vscode.window.showWarningMessage(
            `${invalidIdProfiles.length} profile(s) excluded from set-vura-secrets scripts because their id contains characters outside [A-Za-z0-9_-]. See the generated scripts for details.`
        );
    }

    await offerGitignoreAppend(destDir);

    vscode.window.showInformationMessage(
        `Exported vura-import-profiles.sh, vura-import-profiles.ps1, set-vura-secrets.sh and set-vura-secrets.ps1 to ${destDir}. ` +
        'Fill in real values in set-vura-secrets.*, source it, then run vura-import-profiles.* once and `vura-runner execute ...` from then on.'
    );
}
