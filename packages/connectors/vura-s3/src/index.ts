import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
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
    NormalizedSchema,
    activateVsCodeProvider
} from '@vura-data-os/core-sdk';
import { handleS3Import, handleS3Export, handleS3List } from './s3Handler';
import { buildS3Client, resolveBucket, S3ProfileConfig } from './s3Client';
import { describeSchemaFromSample, groupSampleCandidates } from './schemaIntrospection';

export class S3Provider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider, IStorageProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!s3.import', '!s3.export', '!s3.list'];
    }

    getSettings(): any {
        return {};
    }

    getConnectorKind(): ConnectorKind {
        return 's3';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'region', label: 'AWS Region', type: 'text', required: true, placeholder: 'us-east-1' },
            { key: 'bucket', label: 'Bucket Name', type: 'text', required: true, placeholder: 'my-bucket' },
            {
                key: 'authMode', label: 'Auth Mode', type: 'select', required: true,
                options: ['AccessKey', 'InstanceProfile'], default: 'AccessKey',
                helpText: 'InstanceProfile uses the AWS SDK\'s default credential chain (env vars, instance/task role) instead of a stored key.'
            },
            { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, showWhen: { field: 'authMode', equals: 'AccessKey' } },
            { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', secret: true, required: true, showWhen: { field: 'authMode', equals: 'AccessKey' } }
        ];
    }

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }

    async testConnection(config: Record<string, any>, secret?: string): Promise<{ success: boolean; message: string }> {
        try {
            const profile = { id: '__test__', name: '__test__', kind: 's3', config } as ConnectionProfile<S3ProfileConfig>;
            const client = buildS3Client(profile, secret);
            const bucket = resolveBucket(profile);
            await client.send(new HeadBucketCommand({ Bucket: bucket }));
            return { success: true, message: `Bucket "${bucket}" is reachable.` };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Connection failed.' };
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
        if (commandRoot === '!s3.import') {
            await handleS3Import(cell, logger, env, commandLine);
        } else if (commandRoot === '!s3.export') {
            await handleS3Export(cell, logger, env, commandLine);
        } else if (commandRoot === '!s3.list') {
            await handleS3List(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [];
    }

    // ─── IStorageProvider ────────────────────────────────────────────────────

    private async resolveClient(connectionId: string) {
        const profile = await this.env.getConnectionProfile(connectionId) as ConnectionProfile<S3ProfileConfig> | undefined;
        if (!profile) {
            throw new Error(`Connection profile "${connectionId}" not found.`);
        }
        const secret = await this.env.getProfileSecret(connectionId);
        return { client: buildS3Client(profile, secret), bucket: resolveBucket(profile) };
    }

    async listFiles(connectionId: string, folderPath: string): Promise<StorageEntry[]> {
        const { client, bucket } = await this.resolveClient(connectionId);
        const prefix = folderPath ? folderPath.replace(/\/?$/, '/') : '';
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }));

        const folders: StorageEntry[] = (res.CommonPrefixes || []).map(p => ({
            name: (p.Prefix || '').replace(prefix, '').replace(/\/$/, ''),
            path: p.Prefix || '',
            isFolder: true
        }));
        const files: StorageEntry[] = (res.Contents || [])
            .filter(o => o.Key !== prefix)
            .map(o => ({
                name: (o.Key || '').replace(prefix, ''),
                path: o.Key || '',
                isFolder: false,
                size: o.Size,
                modifiedAt: o.LastModified?.toISOString()
            }));
        return [...folders, ...files];
    }

    async readFile(connectionId: string, filePath: string): Promise<Buffer> {
        const { client, bucket } = await this.resolveClient(connectionId);
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: filePath }));
        return Buffer.from(await res.Body!.transformToByteArray());
    }

    async writeFile(connectionId: string, filePath: string, content: Buffer, mime?: string): Promise<void> {
        const { client, bucket } = await this.resolveClient(connectionId);
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: filePath, Body: content, ContentType: mime }));
    }

    async deleteFile(connectionId: string, filePath: string): Promise<void> {
        const { client, bucket } = await this.resolveClient(connectionId);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: filePath }));
    }
}

export default S3Provider;
export const activate = activateVsCodeProvider(S3Provider, 's3-provider');
