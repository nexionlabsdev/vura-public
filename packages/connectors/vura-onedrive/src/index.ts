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
import { handleOneDriveImport, handleOneDriveExport } from './onedriveHandler';
import { getGraphToken, graphListChildrenUrl, graphContentUrl, graphItemUrl, graphFetch, OneDriveProfileConfig } from './graphClient';

export class OneDriveProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider, IStorageProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!onedrive.import', '!onedrive.export'];
    }

    getSettings(): any {
        return {};
    }

    getConnectorKind(): ConnectorKind {
        return 'onedrive';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'userPrincipalName', label: 'User Principal Name', type: 'text', required: true, placeholder: 'user@contoso.com', helpText: 'The user whose OneDrive this connection accesses (app-only Files.ReadWrite.All).' },
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
        if (!config?.userPrincipalName) {
            return { success: false, message: 'Missing User Principal Name.' };
        }
        try {
            const profile = { id: '__test__', name: '__test__', kind: 'onedrive', config } as ConnectionProfile<OneDriveProfileConfig>;
            const token = await getGraphToken(profile, secret);
            await graphFetch(graphItemUrl(profile, ''), token);
            return { success: true, message: `Connected to "${config.userPrincipalName}"'s OneDrive.` };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Connection failed.' };
        }
    }

    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!onedrive.import') {
            await handleOneDriveImport(cell, logger, env, commandLine);
        } else if (commandRoot === '!onedrive.export') {
            await handleOneDriveExport(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [];
    }

    // ─── IStorageProvider ────────────────────────────────────────────────────

    private async resolveProfileAndToken(connectionId: string) {
        const profile = await this.env.getConnectionProfile(connectionId) as ConnectionProfile<OneDriveProfileConfig> | undefined;
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

export default OneDriveProvider;
export const activate = activateVsCodeProvider(OneDriveProvider, 'onedrive-provider');
