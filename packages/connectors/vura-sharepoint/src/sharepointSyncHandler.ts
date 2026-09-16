import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { ODataSyncEngine } from '@vura-data-os/vura-odata-sync-core';

export interface SyncSharePointArgs {
    source: string;
    target: string;
    mode: 'upsert' | 'insert';
    batchSize: number;
    key?: string;
    siteUrl?: string;
}

export async function handleSyncSharePoint(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseArgs(commandLine);

    const connectionId = cell.metadata?.sharepointConnectionId;
    let siteUrl = args.siteUrl || cell.metadata?.sharepointSiteUrl;
    let getToken: () => Promise<string>;

    // Prefer the first-class 'sharepoint' ConnectionProfile kind; fall back to a
    // legacy SqlProfile-shaped connection (from before SharePoint had its own
    // ConnectionProfile kind) so already-configured connections keep working.
    const connProfile = connectionId ? await env.getConnectionProfile(connectionId) : undefined;

    if (connProfile && connProfile.kind === 'sharepoint') {
        siteUrl = siteUrl || connProfile.config.siteUrl;
        const secret = await env.getProfileSecret(connectionId!);
        getToken = () => acquireToken(connProfile.config.clientId, connProfile.config.tenantId, secret, siteUrl!);
    } else if (connectionId) {
        const profile = await env.getProfile(connectionId);
        if (profile) {
            siteUrl = siteUrl || `https://${profile.server}`;
            const secret = await env.getProfileSecret(profile.id);
            getToken = async () => {
                if (profile.authMode === 'ServicePrincipal') {
                    return acquireToken(profile.clientId!, profile.tenantId!, secret, siteUrl!);
                }
                return secret || '';
            };
        } else {
            getToken = async () => process.env.SHAREPOINT_TOKEN || 'mock_sharepoint_token';
        }
    } else {
        siteUrl = siteUrl || process.env.SHAREPOINT_SITE_URL || 'https://contoso.sharepoint.com';
        getToken = async () => process.env.SHAREPOINT_TOKEN || 'mock_sharepoint_token';
    }

    await ODataSyncEngine.sync({
        baseUrl: siteUrl,
        getToken,
        source: args.source,
        target: args.target,
        mode: args.mode,
        batchSize: args.batchSize,
        key: args.key,
        apiPathPrefix: '/_api/web/lists',
        env,
        logger
    });
}

export function parseArgs(commandLine: string): SyncSharePointArgs {
    const stripped = commandLine.replace(/^!sharepoint\.sync\s*/, '');
    const tokens = stripped.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const args: SyncSharePointArgs = {
        source: '',
        target: '',
        mode: 'upsert',
        batchSize: 500
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        switch (tok) {
            case '--source':
                args.source = unquote(tokens[++i] || '');
                break;
            case '--target':
                args.target = unquote(tokens[++i] || '');
                break;
            case '--mode':
                const mode = unquote(tokens[++i] || '');
                if (mode !== 'upsert' && mode !== 'insert') {
                    throw new Error(`Invalid mode "${mode}". Supported modes: upsert, insert`);
                }
                args.mode = mode;
                break;
            case '--batch_size':
                args.batchSize = parseInt(unquote(tokens[++i] || ''), 10) || 500;
                break;
            case '--key':
                args.key = unquote(tokens[++i] || '');
                break;
            case '--site_url':
                args.siteUrl = unquote(tokens[++i] || '');
                break;
        }
    }

    if (!args.source) throw new Error('Missing required argument: --source <cell_id/table_name>');
    if (!args.target) throw new Error('Missing required argument: --target <sharepoint_list_title>');

    return args;
}

function unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

async function acquireToken(clientId: string, tenantId: string, secret: string | undefined, siteUrl: string): Promise<string> {
    const msal = require('@azure/msal-node');
    const cca = new msal.ConfidentialClientApplication({
        auth: {
            clientId,
            authority: `https://login.microsoftonline.com/${tenantId}`,
            clientSecret: secret
        }
    });
    const response = await cca.acquireTokenByClientCredential({
        scopes: [`${new URL(siteUrl).origin}/.default`]
    });
    return response.accessToken;
}
