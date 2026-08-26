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

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
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
