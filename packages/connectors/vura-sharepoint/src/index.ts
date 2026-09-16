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
    ConnectionProfile,
    activateVsCodeProvider
} from '@vura-data-os/core-sdk';
import { handleSyncSharePoint } from './sharepointSyncHandler';
import { handleSharePointImport, handleSharePointExport } from './sharepointFileHandler';
import { getGraphToken, graphListChildrenUrl, graphContentUrl, graphItemUrl, graphFetch, SharePointProfileConfig } from './graphDriveClient';

export class SharePointProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider, IStorageProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!sharepoint.sync', '!sharepoint.import', '!sharepoint.export'];
    }

    getSettings(): any {
        return {
            "vura.sharepointBatchSize": 500
        };
    }

    getConnectorKind(): ConnectorKind {
        return 'sharepoint';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'siteUrl', label: 'Site URL', type: 'text', required: true, placeholder: 'https://contoso.sharepoint.com/sites/TeamSite' },
            { key: 'tenantId', label: 'Tenant ID', type: 'text', required: true },
            { key: 'clientId', label: 'Client ID (Application ID)', type: 'text', required: true },
            { key: 'clientSecret', label: 'Client Secret', type: 'password', secret: true, required: true }
        ];
    }

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }

    async testConnection(config: Record<string, any>, secret?: string): Promise<{ success: boolean; message: string }> {
        if (!config?.siteUrl) {
            return { success: false, message: 'Missing Site URL.' };
        }
        try {
            const profile = { id: '__test__', name: '__test__', kind: 'sharepoint', config } as ConnectionProfile<SharePointProfileConfig>;
            const token = await getGraphToken(profile, secret);
            await graphFetch(graphItemUrl(profile, ''), token);
            return { success: true, message: `Connected to "${config.siteUrl}".` };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Connection failed.' };
        }
    }

    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!sharepoint.sync') {
            await handleSyncSharePoint(cell, logger, env, commandLine);
        } else if (commandRoot === '!sharepoint.import') {
            await handleSharePointImport(cell, logger, env, commandLine);
        } else if (commandRoot === '!sharepoint.export') {
            await handleSharePointExport(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [
            {
                id: 'sharepoint.sync.picker',
                label: '$(cloud) SharePoint Sync',
                kind: 'quickpick',
                options: async () => ['Documents', 'Lists', 'CustomList'],
                onSelect: async (value: string, cell: FlownbCell) => {
                    const tableName = cell.metadata?.tableName || 'cell_data';
                    const cmd = `!sharepoint.sync --source ${tableName} --target "${value}" --mode upsert\n`;
                    cell.value = cmd + cell.value;
                }
            }
        ];
    }

    // ─── IStorageProvider (document library file access) ────────────────────

    private async resolveProfileAndToken(connectionId: string) {
        const profile = await this.env.getConnectionProfile(connectionId) as ConnectionProfile<SharePointProfileConfig> | undefined;
        if (!profile) {
            throw new Error(`Connection profile "${connectionId}" not found.`);
        }
        const secret = await this.env.getProfileSecret(connectionId);
        const token = await getGraphToken(profile, secret);
        return { profile, token };
    }

    async listFiles(connectionId: string, folderPath: string): Promise<StorageEntry[]> {
        const { profile, token } = await this.resolveProfileAndToken(connectionId);
        const res = await graphFetch(graphListChildrenUrl(profile, folderPath), token);
        const data: any = await res.json();
        return (data.value || []).map((item: any) => ({
            name: item.name,
            path: folderPath ? `${folderPath.replace(/\/$/, '')}/${item.name}` : item.name,
            isFolder: !!item.folder,
            size: item.size,
            modifiedAt: item.lastModifiedDateTime
        }));
    }

    async readFile(connectionId: string, filePath: string): Promise<Buffer> {
        const { profile, token } = await this.resolveProfileAndToken(connectionId);
        const res = await graphFetch(graphContentUrl(profile, filePath), token);
        return Buffer.from(await res.arrayBuffer());
    }

    async writeFile(connectionId: string, filePath: string, content: Buffer): Promise<void> {
        const { profile, token } = await this.resolveProfileAndToken(connectionId);
        await graphFetch(graphContentUrl(profile, filePath), token, { method: 'PUT', body: content as any });
    }

    async deleteFile(connectionId: string, filePath: string): Promise<void> {
        const { profile, token } = await this.resolveProfileAndToken(connectionId);
        await graphFetch(graphItemUrl(profile, filePath), token, { method: 'DELETE' });
    }
}

export default SharePointProvider;
export const activate = activateVsCodeProvider(SharePointProvider, 'sharepoint-provider');
