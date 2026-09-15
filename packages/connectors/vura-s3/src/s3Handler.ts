import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { FlownbCell, ICellLogger, IVuraEnvironment, ConnectionProfile } from '@vura-data-os/core-sdk';
import { recordsToBuffer, loadBufferIntoTable } from './fileFormats';
import { tokenize, readFlags } from './argParsing';
import { buildS3Client, resolveBucket, S3ProfileConfig } from './s3Client';

export interface S3ImportArgs {
    connection: string;
    key: string;
    format: string;
    target: string;
}

export interface S3ExportArgs {
    connection: string;
    source: string;
    format: string;
    key: string;
}

async function resolveProfile(env: IVuraEnvironment, connectionId: string): Promise<{ profile: ConnectionProfile<S3ProfileConfig>; secret: string | undefined }> {
    const profile = await env.getConnectionProfile(connectionId) as ConnectionProfile<S3ProfileConfig> | undefined;
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }
    const secret = await env.getProfileSecret(connectionId);
    return { profile, secret };
}

export function parseImportArgs(commandLine: string): S3ImportArgs {
    const tokens = tokenize(commandLine, '!s3.import');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.key) throw new Error('Missing required argument: --key <object_key>');
    if (!args.target) throw new Error('Missing required argument: --target <table_name>');
    return args;
}

export function parseExportArgs(commandLine: string): S3ExportArgs {
    const tokens = tokenize(commandLine, '!s3.export');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.source) throw new Error('Missing required argument: --source <table_name>');
    if (!args.key) throw new Error('Missing required argument: --key <object_key>');
    return args;
}

export async function handleS3Import(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseImportArgs(commandLine);
    const { profile, secret } = await resolveProfile(env, args.connection);
    const client = buildS3Client(profile, secret);
    const bucket = resolveBucket(profile);

    await logger.logText(`Downloading s3://${bucket}/${args.key}...`);
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: args.key }));
    const buffer = Buffer.from(await res.Body!.transformToByteArray());

    const rowCount = await loadBufferIntoTable(env, buffer, args.format, args.target);
    await logger.logText(`Imported ${rowCount} record(s) into table "${args.target}".`);
}

export async function handleS3Export(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseExportArgs(commandLine);
    const { profile, secret } = await resolveProfile(env, args.connection);
    const client = buildS3Client(profile, secret);
    const bucket = resolveBucket(profile);

    let records: any[];
    try {
        records = await env.runLocalQuery(`SELECT * FROM "${args.source}"`);
    } catch (err: any) {
        throw new Error(`Failed to read from local table "${args.source}": ${err.message}`);
    }

    const buffer = await recordsToBuffer(records, args.format);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: args.key, Body: buffer }));
    await logger.logText(`Exported ${records.length} record(s) from "${args.source}" to s3://${bucket}/${args.key}.`);
}

export async function handleS3List(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const tokens = tokenize(commandLine, '!s3.list');
    const args: any = { prefix: '' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');

    const { profile, secret } = await resolveProfile(env, args.connection);
    const client = buildS3Client(profile, secret);
    const bucket = resolveBucket(profile);

    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: args.prefix || undefined }));
    const keys = (res.Contents || []).map(o => `${o.Key} (${o.Size} bytes)`);
    await logger.logText(keys.length > 0 ? keys.join('\n') : `No objects found under s3://${bucket}/${args.prefix || ''}`);
}
