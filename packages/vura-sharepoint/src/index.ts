import {
    IVuraProvider,
    IConnectionAdapter,
    BaseAdapter,
    FlownbCell,
    ICellLogger,
    IVuraEnvironment,
    IUIActionProvider,
    UIAction,
    activateVsCodeProvider
} from '@vura-data-os/core-sdk';
import { handleSyncSharePoint } from './sharepointSyncHandler';

export class SharePointProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!sharepoint.sync'];
    }

    getSettings(): any {
        return {
            "vura.sharepointBatchSize": 500
        };
    }

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }

    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!sharepoint.sync') {
            await handleSyncSharePoint(cell, logger, env, commandLine);
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
}

export default SharePointProvider;
export const activate = activateVsCodeProvider(SharePointProvider, 'sharepoint-provider');
