import {
    IVuraProvider,
    IConnectionAdapter,
    BaseAdapter,
    FlownbCell,
    ICellLogger,
    IVuraEnvironment,
    IUIActionProvider,
    UIAction,
    ConnectionField,
    ConnectorKind,
    activateVsCodeProvider
} from '@vura-data-os/core-sdk';
import { handleSyncDataverse } from './syncDataverseHandler';

export class DataverseProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!dataverse.sync', '!sync_dataverse'];
    }

    getSettings(): any {
        return {
            "vura.odataBatchSize": 500
        };
    }

    getConnectorKind(): ConnectorKind {
        return 'dataverse';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'environmentUrl', label: 'Environment URL', type: 'text', required: true, placeholder: 'https://org.crm.dynamics.com' },
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
        const { environmentUrl, tenantId, clientId } = config || {};
        if (!environmentUrl || !tenantId || !clientId) {
            return { success: false, message: 'Missing Environment URL, Tenant ID, or Client ID.' };
        }
        if (!secret) {
            return { success: false, message: 'Missing Client Secret.' };
        }
        try {
            const msal = require('@azure/msal-node');
            const origin = new URL(environmentUrl).origin;
            const cca = new msal.ConfidentialClientApplication({
                auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientSecret: secret }
            });
            const token = await cca.acquireTokenByClientCredential({ scopes: [`${origin}/.default`] });
            if (!token?.accessToken) {
                return { success: false, message: 'Failed to acquire an access token — check Tenant ID / Client ID / Client Secret.' };
            }
            const res = await fetch(`${origin}/api/data/v9.2/WhoAmI`, {
                headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' }
            });
            if (!res.ok) {
                return { success: false, message: `Dataverse responded ${res.status} ${res.statusText}.` };
            }
            const data: any = await res.json();
            return { success: true, message: `Connected. UserId: ${data.UserId}` };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Connection failed.' };
        }
    }

    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!dataverse.sync' || commandRoot === '!sync_dataverse') {
            await handleSyncDataverse(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [
            {
                id: 'dataverse.sync.picker',
                label: '$(cloud) Dataverse Sync',
                kind: 'quickpick',
                options: async () => ['accounts', 'contacts', 'leads'],
                onSelect: async (value: string, cell: FlownbCell) => {
                    const tableName = cell.metadata?.tableName || 'cell_data';
                    const cmd = `!dataverse.sync --source ${tableName} --target "${value}" --mode upsert\n`;
                    cell.value = cmd + cell.value;
                }
            }
        ];
    }
}

export default DataverseProvider;
export const activate = activateVsCodeProvider(DataverseProvider, 'dataverse-provider');
