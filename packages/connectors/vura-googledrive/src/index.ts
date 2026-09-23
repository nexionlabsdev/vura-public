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
import { handleGoogleDriveImport, handleGoogleDriveExport } from './googledriveHandler';
import { buildJwtClient, driveFetch, DRIVE_BASE, DRIVE_UPLOAD_BASE, GoogleDriveProfileConfig } from './driveClient';
import { describeGoogleDriveSchema } from './schemaIntrospection';

export class GoogleDriveProvider extends BaseAdapter implements IVuraProvider, IConnectionAdapter, IUIActionProvider, IStorageProvider {
    async activate(env: IVuraEnvironment): Promise<void> {
        await super.activate(env);
    }

    getCommands(): string[] {
        return ['!googledrive.import', '!googledrive.export'];
    }

    getSettings(): any {
        return {};
    }

    getConnectorKind(): ConnectorKind {
        return 'googledrive';
    }

    getConnectionFields(): ConnectionField[] {
        return [
            { key: 'serviceAccountKey', label: 'Service Account Key', type: 'password', secret: true, required: true, helpText: 'Paste the full service-account JSON key (recommended), or just the private key PEM paired with the email below.' },
            { key: 'serviceAccountEmail', label: 'Service Account Email', type: 'text', helpText: 'Only required if the key above is a raw private key rather than a full JSON key.' },
            { key: 'impersonateUser', label: 'Impersonate User (domain-wide delegation, optional)', type: 'text' }
        ];
    }

    async connect(): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }

    async testConnection(config: Record<string, any>, secret?: string): Promise<{ success: boolean; message: string }> {
        try {
            const profile = { id: '__test__', name: '__test__', kind: 'googledrive', config } as ConnectionProfile<GoogleDriveProfileConfig>;
            const client = buildJwtClient(profile, secret);
            const res = await driveFetch(client, `${DRIVE_BASE}/about?fields=user`);
            const data: any = await res.json();
            return { success: true, message: `Connected as ${data.user?.emailAddress || 'service account'}.` };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Connection failed.' };
        }
    }

    async sync(args: any): Promise<any> {
    }

    async describeSchema(connectionId: string): Promise<NormalizedSchema> {
        const client = await this.resolveClient(connectionId);
        return describeGoogleDriveSchema(client);
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void> {
        if (commandRoot === '!googledrive.import') {
            await handleGoogleDriveImport(cell, logger, env, commandLine);
        } else if (commandRoot === '!googledrive.export') {
            await handleGoogleDriveExport(cell, logger, env, commandLine);
        }
    }

    getUIActions(cell: FlownbCell): UIAction[] {
        return [];
    }

    // ─── IStorageProvider (folderPath / filePath are Drive file/folder IDs) ──

    private async resolveClient(connectionId: string) {
        const profile = await this.env.getConnectionProfile(connectionId) as ConnectionProfile<GoogleDriveProfileConfig> | undefined;
        if (!profile) {
            throw new Error(`Connection profile "${connectionId}" not found.`);
        }
        const secret = await this.env.getProfileSecret(connectionId);
        return buildJwtClient(profile, secret);
    }

    async listFiles(connectionId: string, folderPath: string): Promise<StorageEntry[]> {
        const client = await this.resolveClient(connectionId);
        const parent = folderPath || 'root';
        const q = encodeURIComponent(`'${parent}' in parents and trashed = false`);
        const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime)');
        const res = await driveFetch(client, `${DRIVE_BASE}/files?q=${q}&fields=${fields}`);
        const data: any = await res.json();
        return (data.files || []).map((f: any) => ({
            name: f.name,
            path: f.id,
            isFolder: f.mimeType === 'application/vnd.google-apps.folder',
            size: f.size ? Number(f.size) : undefined,
            modifiedAt: f.modifiedTime
        }));
    }

    async readFile(connectionId: string, filePath: string): Promise<Buffer> {
        const client = await this.resolveClient(connectionId);
        const res = await driveFetch(client, `${DRIVE_BASE}/files/${encodeURIComponent(filePath)}?alt=media`);
        return Buffer.from(await res.arrayBuffer());
    }

    async writeFile(connectionId: string, filePath: string, content: Buffer, mime?: string): Promise<void> {
        const client = await this.resolveClient(connectionId);
        // `filePath` is treated as an existing Drive file id to update in place.
        await driveFetch(client, `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(filePath)}?uploadType=media`, {
            method: 'PATCH',
            headers: mime ? { 'Content-Type': mime } : undefined,
            body: content as any
        });
    }

    async deleteFile(connectionId: string, filePath: string): Promise<void> {
        const client = await this.resolveClient(connectionId);
        await driveFetch(client, `${DRIVE_BASE}/files/${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    }
}

export default GoogleDriveProvider;
export const activate = activateVsCodeProvider(GoogleDriveProvider, 'googledrive-provider');
