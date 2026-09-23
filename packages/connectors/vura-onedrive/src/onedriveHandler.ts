import { FlownbCell, ICellLogger, IVuraEnvironment, ConnectionProfile } from '@vura-data-os/core-sdk';
import { recordsToBuffer, loadBufferIntoTable } from './fileFormats';
import { tokenize, readFlags } from './argParsing';
import { getGraphToken, graphContentUrl, graphFetch, OneDriveProfileConfig } from './graphClient';

export interface OneDriveImportArgs {
    connection: string;
    path: string;
    format: string;
    target: string;
}

export interface OneDriveExportArgs {
    connection: string;
    source: string;
    format: string;
    path: string;
}

async function resolveProfile(env: IVuraEnvironment, connectionId: string): Promise<{ profile: ConnectionProfile<OneDriveProfileConfig>; secret: string | undefined }> {
    const profile = await env.getConnectionProfile(connectionId) as ConnectionProfile<OneDriveProfileConfig> | undefined;
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }
    const secret = await env.getProfileSecret(connectionId);
    return { profile, secret };
}

export function parseImportArgs(commandLine: string): OneDriveImportArgs {
    const tokens = tokenize(commandLine, '!onedrive.import');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.path) throw new Error('Missing required argument: --path <file_path>');
    if (!args.target) throw new Error('Missing required argument: --target <table_name>');
    return args;
}

export function parseExportArgs(commandLine: string): OneDriveExportArgs {
    const tokens = tokenize(commandLine, '!onedrive.export');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.source) throw new Error('Missing required argument: --source <table_name>');
    if (!args.path) throw new Error('Missing required argument: --path <file_path>');
    return args;
}

export async function handleOneDriveImport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseImportArgs(commandLine);
    const { profile, secret } = await resolveProfile(env, args.connection);
    const token = await getGraphToken(profile, secret);

    await logger.logText(`Downloading "${args.path}" from OneDrive (${profile.config.userPrincipalName})...`);
    const res = await graphFetch(graphContentUrl(profile, args.path), token);
    const buffer = Buffer.from(await res.arrayBuffer());

    const rowCount = await loadBufferIntoTable(env, buffer, args.format, args.target);
    await logger.logText(`Imported ${rowCount} record(s) into table "${args.target}".`);
}

export async function handleOneDriveExport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseExportArgs(commandLine);
    const { profile, secret } = await resolveProfile(env, args.connection);
    const token = await getGraphToken(profile, secret);

    let records: any[];
    try {
        records = await env.runLocalQuery(`SELECT * FROM "${args.source}"`);
    } catch (err: any) {
        throw new Error(`Failed to read from local table "${args.source}": ${err.message}`);
    }

    const buffer = await recordsToBuffer(records, args.format);
    // PUT :/content uploads files up to 4MB directly; larger exports would need
    // Graph's resumable upload-session API, which is out of scope here.
    await graphFetch(graphContentUrl(profile, args.path), token, {
        method: 'PUT',
        body: buffer as any
    });
    await logger.logText(`Exported ${records.length} record(s) from "${args.source}" to OneDrive path "${args.path}".`);
}
