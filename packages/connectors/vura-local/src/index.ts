import * as fs from 'fs';
import * as path from 'path';
import {
    IVuraProvider,
    IConnectionAdapter,
    BaseAdapter,
    FlownbCell,
    ICellLogger,
    IVuraEnvironment,
    IUIActionProvider,
    UIAction,
    IStorageProvider,
    StorageEntry,
    ConnectionField,
    ConnectorKind,
    NormalizedSchema,
    activateVsCodeProvider
} from '@vura-data-os/core-sdk';
import { handleLocalImport, handleLocalExport } from './localHandler';
import { describeSchemaFromSample, groupSampleCandidates } from './schemaIntrospection';

export class LocalProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider, IStorageProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!local.import', '!local.export'];
    }

    getSettings(): any {
        return {};
    }

    getConnectorKind(): ConnectorKind {
        return 'local';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'basePath', label: 'Base Folder Path', type: 'folder', required: true, placeholder: '/Users/me/shared-folder', helpText: 'An absolute path (or a mapped/mounted drive) this connection resolves relative import/export paths against.' }
        ];
    }

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }

    async testConnection(config: Record<string, any>): Promise<{ success: boolean; message: string }> {
        const basePath = config?.basePath;
        if (!basePath) {
            return { success: false, message: 'Missing Base Folder Path.' };
        }
        try {
            const stat = fs.statSync(basePath);
            if (!stat.isDirectory()) {
                return { success: false, message: `"${basePath}" exists but is not a directory.` };
            }
            fs.accessSync(basePath, fs.constants.R_OK | fs.constants.W_OK);
            return { success: true, message: `"${basePath}" is a readable/writable directory.` };
        } catch (err: any) {
            return { success: false, message: err?.code === 'ENOENT' ? `Folder does not exist: ${basePath}` : (err?.message || 'Folder is not accessible.') };
        }
    }

    async sync(args: any): Promise<any> {
    }

    async describeSchema(connectionId: string): Promise<NormalizedSchema> {
        const files = await this.listFiles(connectionId, '');
        const candidates = groupSampleCandidates(files.filter(f => !f.isFolder).map(f => f.path));

        const entities = await Promise.all(candidates.map(async ({ path: filePath, format }) => {
            const buffer = await this.readFile(connectionId, filePath);
            return describeSchemaFromSample(this.env, buffer, format, filePath);
        }));

        return { entities };
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!local.import') {
            await handleLocalImport(cell, logger, env, commandLine);
        } else if (commandRoot === '!local.export') {
            await handleLocalExport(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [];
    }

    // ─── IStorageProvider ────────────────────────────────────────────────────

    private async resolveBase(connectionId: string): Promise<string> {
        const profile = await this.env.getConnectionProfile(connectionId);
        const basePath = profile?.config?.basePath;
        if (!basePath) {
            throw new Error(`Connection "${connectionId}" not found or missing "basePath".`);
        }
        return basePath;
    }

    async listFiles(connectionId: string, folderPath: string): Promise<StorageEntry[]> {
        const base = await this.resolveBase(connectionId);
        const dir = path.resolve(base, folderPath || '.');
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const results: StorageEntry[] = [];
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const stat = await fs.promises.stat(full);
            results.push({
                name: entry.name,
                path: path.relative(base, full),
                isFolder: entry.isDirectory(),
                size: stat.size,
                modifiedAt: stat.mtime.toISOString()
            });
        }
        return results;
    }

    async readFile(connectionId: string, filePath: string): Promise<Buffer> {
        const base = await this.resolveBase(connectionId);
        return fs.promises.readFile(path.resolve(base, filePath));
    }

    async writeFile(connectionId: string, filePath: string, content: Buffer): Promise<void> {
        const base = await this.resolveBase(connectionId);
        const abs = path.resolve(base, filePath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content);
    }

    async deleteFile(connectionId: string, filePath: string): Promise<void> {
        const base = await this.resolveBase(connectionId);
        await fs.promises.unlink(path.resolve(base, filePath));
    }
}

export default LocalProvider;
export const activate = activateVsCodeProvider(LocalProvider, 'local-provider');
