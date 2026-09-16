import { FlownbCell, ICellLogger, IVuraEnvironment, ConnectionProfile } from '@vura-data-os/core-sdk';
import { recordsToBuffer, loadBufferIntoTable } from './fileFormats';
import { tokenize, readFlags } from './argParsing';
import { buildJwtClient, driveFetch, DRIVE_BASE, DRIVE_UPLOAD_BASE, GoogleDriveProfileConfig } from './driveClient';

export interface GoogleDriveImportArgs {
    connection: string;
    fileId: string;
    format: string;
    target: string;
}

export interface GoogleDriveExportArgs {
    connection: string;
    source: string;
    format: string;
    name: string;
    folderId?: string;
    fileId?: string; // update an existing file instead of creating a new one
}

async function resolveClient(env: IVuraEnvironment, connectionId: string) {
    const profile = await env.getConnectionProfile(connectionId) as ConnectionProfile<GoogleDriveProfileConfig> | undefined;
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }
    const secret = await env.getProfileSecret(connectionId);
    return buildJwtClient(profile, secret);
}

export function parseImportArgs(commandLine: string): GoogleDriveImportArgs {
    const tokens = tokenize(commandLine, '!googledrive.import');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.fileId) throw new Error('Missing required argument: --file-id <drive_file_id>');
    if (!args.target) throw new Error('Missing required argument: --target <table_name>');
    return args;
}

export function parseExportArgs(commandLine: string): GoogleDriveExportArgs {
    const tokens = tokenize(commandLine, '!googledrive.export');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.source) throw new Error('Missing required argument: --source <table_name>');
    if (!args.name && !args.fileId) throw new Error('Missing required argument: --name <file_name> (or --file-id to update an existing file)');
    return args;
}

export async function handleGoogleDriveImport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseImportArgs(commandLine);
    const client = await resolveClient(env, args.connection);

    await logger.logText(`Downloading Google Drive file "${args.fileId}"...`);
    const res = await driveFetch(client, `${DRIVE_BASE}/files/${encodeURIComponent(args.fileId)}?alt=media`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const rowCount = await loadBufferIntoTable(env, buffer, args.format, args.target);
    await logger.logText(`Imported ${rowCount} record(s) into table "${args.target}".`);
}

export async function handleGoogleDriveExport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseExportArgs(commandLine);
    const client = await resolveClient(env, args.connection);

    let records: any[];
    try {
        records = await env.runLocalQuery(`SELECT * FROM "${args.source}"`);
    } catch (err: any) {
        throw new Error(`Failed to read from local table "${args.source}": ${err.message}`);
    }

    const buffer = await recordsToBuffer(records, args.format);

    if (args.fileId) {
        await driveFetch(client, `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(args.fileId)}?uploadType=media`, {
            method: 'PATCH',
            body: buffer as any
        });
        await logger.logText(`Exported ${records.length} record(s) from "${args.source}" to Google Drive file "${args.fileId}".`);
        return;
    }

    const metadata: any = { name: args.name };
    if (args.folderId) metadata.parents = [args.folderId];

    const boundary = `vura_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, 'utf8'),
        Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'),
        buffer,
        Buffer.from(`\r\n--${boundary}--`, 'utf8')
    ]);

    const res = await driveFetch(client, `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody as any
    });
    const created: any = await res.json();
    await logger.logText(`Exported ${records.length} record(s) from "${args.source}" to new Google Drive file "${args.name}" (id: ${created.id}).`);
}
