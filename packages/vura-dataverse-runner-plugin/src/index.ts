import { IVuraProvider, IConnectionAdapter, BaseAdapter, FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { handleSyncDataverse } from '@vura-data-os/vura-dataverse-sync-core';

/**
 * vura-runner CLI plugin adding `!sync_dataverse` support. Shares the actual
 * sync engine (@vura-data-os/vura-dataverse-sync-core) with the VS Code
 * vura-dataverse-adapter Add-on — this class is just the thin
 * registration/dispatch wrapper for the CLI host, mirroring what
 * vura-dataverse-adapter's DataverseProvider does for VS Code.
 *
 * Install and declare it either via a notebook's `requiredPlugins` field, or
 * globally: `vura-runner config set vura.plugins '["@vura-data-os/vura-dataverse-runner-plugin"]'`
 */
export default class DataverseRunnerPlugin extends BaseAdapter implements IVuraProvider, IConnectionAdapter {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!sync_dataverse'];
    }

    getSettings(): any {
        return {
            "vura.odataBatchSize": 500
        };
    }

    async connect(): Promise<void> {
        // No-op: the CLI resolves connection profiles/secrets directly via
        // IVuraEnvironment (see handleSyncDataverse), there's no orchestrator
        // to connect to outside of VURA Enterprise.
    }

    async validate(): Promise<boolean> {
        return true;
    }

    /**
     * IConnectionAdapter's generic sync hook — unrelated to magic command
     * dispatch (see handleCommand below). Not currently used by this plugin.
     */
    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!sync_dataverse') {
            await handleSyncDataverse(cell, logger, env, commandLine);
        }
    }
}
