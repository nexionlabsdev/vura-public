import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { ODataSyncEngine, EntityMetadata, AlternateKey } from '@vura-data-os/vura-odata-sync-core';

export interface SyncDataverseArgs {
    source: string;
    target: string;
    mode: 'upsert' | 'insert';
    batchSize: number;
    key?: string;
}

export async function handleSyncDataverse(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    const args = parseArgs(commandLine);

    const connectionId = cell.metadata?.dataverseConnectionId;
    if (!connectionId) {
        throw new Error(
            'No Dataverse connection selected. Use the status bar to pick a Dataverse connection for this cell.'
        );
    }

    const profile = await env.getProfile(connectionId);
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }

    const secret = await env.getProfileSecret(profile.id);
    const orgUrl = `https://${profile.server}`;

    await ODataSyncEngine.sync({
        baseUrl: orgUrl,
        getToken: () => getToken(profile, secret),
        source: args.source,
        target: args.target,
        mode: args.mode,
        batchSize: args.batchSize,
        key: args.key,
        apiPathPrefix: '/api/data/v9.2',
        fetchMetadata: (baseUrl: string, logicalName: string, token: string) => fetchEntityMetadata(baseUrl, logicalName, token),
        env,
        logger
    });
}

export function parseArgs(commandLine: string): SyncDataverseArgs {
    const stripped = commandLine.replace(/^!(?:sync_dataverse|dataverse\.sync)\s*/, '');
    const tokens = stripped.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const args: SyncDataverseArgs = {
        source: '',
        target: '',
        mode: 'upsert',
        batchSize: 1000
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
                args.batchSize = parseInt(unquote(tokens[++i] || ''), 10) || 1000;
                break;
            case '--key':
                args.key = unquote(tokens[++i] || '');
                break;
        }
    }

    if (!args.source) throw new Error('Missing required argument: --source <cell_id/table_name>');
    if (!args.target) throw new Error('Missing required argument: --target <dataverse_entity_logical_name>');

    return args;
}

function unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

async function getToken(profile: any, secret: string | undefined): Promise<string> {
    const msal = require('@azure/msal-node');
    if (profile.authMode === 'ServicePrincipal') {
        const cca = new msal.ConfidentialClientApplication({
            auth: {
                clientId: profile.clientId,
                authority: `https://login.microsoftonline.com/${profile.tenantId}`,
                clientSecret: secret
            }
        });
        const response = await cca.acquireTokenByClientCredential({
            scopes: [`https://${profile.server}/.default`]
        });
        return response.accessToken;
    }
    throw new Error(`Auth mode "${profile.authMode}" is not supported for Dataverse sync. Use ServicePrincipal.`);
}

async function fetchEntityMetadata(orgUrl: string, logicalName: string, token: string): Promise<EntityMetadata> {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
    };

    const defUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')?$select=PrimaryIdAttribute,EntitySetName`;
    const defRes = await fetch(defUrl, { headers });
    if (!defRes.ok) {
        const body = await defRes.text();
        throw new Error(`Failed to fetch entity definition for "${logicalName}": ${defRes.status} ${defRes.statusText}\n${body}`);
    }
    const defData: any = await defRes.json();

    const keysUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Keys?$select=LogicalName,KeyAttributes`;
    const keysRes = await fetch(keysUrl, { headers });
    let alternateKeys: AlternateKey[] = [];
    if (keysRes.ok) {
        const keysData: any = await keysRes.json();
        alternateKeys = (keysData.value || []).map((k: any) => ({
            logicalName: k.LogicalName,
            keyAttributes: k.KeyAttributes || []
        }));
    }

    const attrUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName`;
    const attrRes = await fetch(attrUrl, { headers });
    let attributes: string[] = [];
    if (attrRes.ok) {
        const attrData: any = await attrRes.json();
        attributes = (attrData.value || []).map((a: any) => a.LogicalName);
    }

    return {
        primaryIdAttribute: defData.PrimaryIdAttribute,
        entitySetName: defData.EntitySetName,
        alternateKeys,
        attributes
    };
}
