import * as path from 'path';
import * as fs from 'fs';
import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { recordsToBuffer, loadBufferIntoTable } from './fileFormats';
import { tokenize, readFlags } from './argParsing';

export interface LocalImportArgs {
    connection: string;
    path: string;
    format: string;
    target: string;
}

export interface LocalExportArgs {
    connection: string;
    source: string;
    format: string;
    path: string;
}

function resolveBasePath(profile: { id: string; config: Record<string, any> } | undefined, connectionId: string): string {
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }
    const basePath = profile.config?.basePath;
    if (!basePath) {
        throw new Error(`Connection "${connectionId}" is missing required field "basePath".`);
    }
    return basePath;
}

export function parseImportArgs(commandLine: string): LocalImportArgs {
    const tokens = tokenize(commandLine, '!local.import');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.path) throw new Error('Missing required argument: --path <relative_file_path>');
    if (!args.target) throw new Error('Missing required argument: --target <table_name>');
    return args;
}

export function parseExportArgs(commandLine: string): LocalExportArgs {
    const tokens = tokenize(commandLine, '!local.export');
    const args: any = { format: 'csv' };
    readFlags(tokens, args);
    if (!args.connection) throw new Error('Missing required argument: --connection <id>');
    if (!args.source) throw new Error('Missing required argument: --source <table_name>');
    if (!args.path) throw new Error('Missing required argument: --path <relative_file_path>');
    return args;
}

export async function handleLocalImport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseImportArgs(commandLine);
    const profile = await env.getConnectionProfile(args.connection);
    const basePath = resolveBasePath(profile, args.connection);

    const absPath = path.resolve(basePath, args.path);
    if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${absPath}`);
    }

    await logger.logText(`Reading "${args.path}" from local connection "${args.connection}"...`);
    const buffer = await fs.promises.readFile(absPath);
    const rowCount = await loadBufferIntoTable(env, buffer, args.format, args.target);
    await logger.logText(`Imported ${rowCount} record(s) into table "${args.target}".`);
}

export async function handleLocalExport(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseExportArgs(commandLine);
    const profile = await env.getConnectionProfile(args.connection);
    const basePath = resolveBasePath(profile, args.connection);

    let records: any[];
    try {
        records = await env.runLocalQuery(`SELECT * FROM "${args.source}"`);
    } catch (err: any) {
        throw new Error(`Failed to read from local table "${args.source}": ${err.message}`);
    }

    const buffer = await recordsToBuffer(records, args.format);
    const absPath = path.resolve(basePath, args.path);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, buffer);
    await logger.logText(`Exported ${records.length} record(s) from "${args.source}" to "${args.path}".`);
}
