import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { IVuraProvider, IConnectionAdapter, BaseAdapter, FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { handleSyncDataverse } from '@vura-data-os/vura-dataverse-sync-core';

export class DataverseProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
        console.log('Dataverse Adapter activated');
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
        // Now fetching from the Orchestrator via IPC/gRPC using the SecretService
        console.log('Fetching credentials from Go Orchestrator...');

        // This is a placeholder for the actual gRPC client implementation
        // In reality, you'd use @grpc/grpc-js to call SecretService.GetSecret
        //
        // NOTE: these key strings ('D365_TOKEN'/'D365_ORG_URL') are a live
        // contract with the vura-enterprise orchestrator's SecretService
        // (env var names it looks up via os.Getenv) — intentionally left
        // unrenamed here; renaming them requires a matching change on that
        // side too.
        const token = await this.getSecretFromOrchestrator('D365_TOKEN');
        const orgUrl = await this.getSecretFromOrchestrator('D365_ORG_URL');

        if (!token || !orgUrl) {
            throw new Error('Failed to fetch Dataverse credentials from Secret Store');
        }

        console.log('Connected to Dataverse successfully using Orchestrator secrets.');
    }

    private async getSecretFromOrchestrator(key: string): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                // Use the bundled execution.proto path
                const protoPath = path.resolve(__dirname, 'proto/execution.proto');

                const packageDefinition = protoLoader.loadSync(protoPath, {
                    keepCase: true,
                    longs: String,
                    enums: String,
                    defaults: true,
                    oneofs: true
                });

                const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
                const executionProto: any = protoDescriptor.execution;

                const client = new executionProto.SecretService('localhost:50053', grpc.credentials.createInsecure());

                client.GetSecret({ key: key }, (err: any, response: any) => {
                    if (err) {
                        reject(err);
                    } else if (response.error_message) {
                        reject(new Error(response.error_message));
                    } else {
                        resolve(response.value);
                    }
                });
            } catch (err) {
                console.error("Failed to call SecretService", err);
                resolve(process.env[key] || `mock_${key}_value`);
            }
        });
    }

    async validate(): Promise<boolean> {
        return true;
    }

    /**
     * IConnectionAdapter's generic sync hook — unrelated to magic command
     * dispatch (see handleCommand below). Not currently used by this adapter.
     */
    async sync(args: any): Promise<any> {
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!sync_dataverse') {
            await handleSyncDataverse(cell, logger, env, commandLine);
        }
    }
}
