import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';
import { ODataSyncEngine, EntityMetadata, AlternateKey, PolymorphicLookupTarget } from '@vura-data-os/vura-odata-sync-core';

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

    // Prefer the first-class 'dataverse' ConnectionProfile kind; fall back to a
    // legacy SqlProfile-shaped connection (environmentUrl overloaded as
    // `server`) so already-configured connections keep working unmodified.
    const connProfile = await env.getConnectionProfile(connectionId);
    let orgUrl: string;
    let authProfile: { authMode?: string; clientId?: string; tenantId?: string };

    if (connProfile && connProfile.kind === 'dataverse') {
        orgUrl = connProfile.config.environmentUrl;
        authProfile = { authMode: 'ServicePrincipal', clientId: connProfile.config.clientId, tenantId: connProfile.config.tenantId };
    } else {
        const legacyProfile = await env.getProfile(connectionId);
        if (!legacyProfile) {
            throw new Error(`Connection profile "${connectionId}" not found.`);
        }
        orgUrl = `https://${legacyProfile.server}`;
        authProfile = legacyProfile;
    }

    const secret = await env.getProfileSecret(connectionId);

    await ODataSyncEngine.sync({
        baseUrl: orgUrl,
        getToken: () => getToken(authProfile, orgUrl, secret),
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

export async function getToken(profile: any, orgUrl: string, secret: string | undefined): Promise<string> {
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
            scopes: [`${new URL(orgUrl).origin}/.default`]
        });
        return response.accessToken;
    }
    throw new Error(`Auth mode "${profile.authMode}" is not supported for Dataverse sync. Use ServicePrincipal.`);
}

export async function fetchEntityMetadata(orgUrl: string, logicalName: string, token: string): Promise<EntityMetadata> {
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

    // IsValidForCreate/IsValidForUpdate are Dataverse's authoritative flags for most read-only
    // attributes (createdon, modifiedby, ...) — but NOT for `owneridtype`/`<lookup>type`
    // companion attributes: Dataverse's own metadata reports those as writable
    // (IsValidForCreate/IsValidForUpdate: true) even though a direct write is always rejected
    // with "Invalid property ... does not exist on type" (0x80048d19). These are
    // `AttributeType: 'EntityName'` — a virtual discriminator that only exists to record which
    // entity a *polymorphic lookup* (ownerid, customerid, ...) is currently bound to, and is
    // set implicitly by whichever entity set the paired lookup's @odata.bind points at. So
    // AttributeType is checked as a second, harder rule that overrides IsValidForCreate/
    // IsValidForUpdate whenever they disagree, rather than trusting either signal alone.
    const attrUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName,AttributeType,IsValidForCreate,IsValidForUpdate`;
    const attrRes = await fetch(attrUrl, { headers });
    let attributes: string[] = [];
    const attributeWritability: Record<string, { validForCreate: boolean; validForUpdate: boolean }> = {};
    if (attrRes.ok) {
        const attrData: any = await attrRes.json();
        for (const a of attrData.value || []) {
            attributes.push(a.LogicalName);
            const isEntityNameDiscriminator = a.AttributeType === 'EntityName';
            attributeWritability[String(a.LogicalName).toLowerCase()] = {
                validForCreate: !isEntityNameDiscriminator && a.IsValidForCreate !== false,
                validForUpdate: !isEntityNameDiscriminator && a.IsValidForUpdate !== false
            };
        }
    }

    const { lookupAttributes, polymorphicLookupAttributes } = await fetchLookupAttributes(orgUrl, logicalName, headers);

    // Deterministic backstop, independent of the AttributeType-string check above: every
    // polymorphic lookup (ownerid, customerid, ...) has a paired `<attr>type` discriminator
    // that Dataverse always populates itself from the lookup's own @odata.bind target and
    // never accepts as a direct write. This holds regardless of what IsValidForCreate/
    // IsValidForUpdate/AttributeType happen to report for a given Dataverse version, so it's
    // forced off here rather than trusted to the metadata flags alone.
    for (const lookupAttr of Object.keys(polymorphicLookupAttributes)) {
        const typeAttr = `${lookupAttr.toLowerCase()}type`;
        if (attributeWritability[typeAttr]) {
            attributeWritability[typeAttr] = { validForCreate: false, validForUpdate: false };
        }
    }

    return {
        primaryIdAttribute: defData.PrimaryIdAttribute,
        entitySetName: defData.EntitySetName,
        alternateKeys,
        attributes,
        lookupAttributes,
        polymorphicLookupAttributes,
        attributeWritability
    };
}

/**
 * Maps this entity's lookup/reference attributes (transactioncurrencyid, ownerid, ...) to the
 * entity-set name(s) they point at, so ODataSyncEngine can write them as `<attr>@odata.bind`
 * instead of a plain scalar — Dataverse rejects a raw value for a lookup with
 * "expected a 'StartObject'/'StartArray' node or null" (0x80048d19).
 *
 * Single-target lookups (transactioncurrencyid -> transactioncurrency) resolve unambiguously
 * here. Polymorphic ones (ownerid -> systemuser|team, customerid -> account|contact) go into
 * `polymorphicLookupAttributes` instead — ODataSyncEngine.buildRequestBody resolves which
 * target a given record actually uses (type-hint column, or the `ownerid` default).
 */
async function fetchLookupAttributes(
    orgUrl: string,
    logicalName: string,
    headers: Record<string, string>
): Promise<{ lookupAttributes: Record<string, string>; polymorphicLookupAttributes: Record<string, PolymorphicLookupTarget[]> }> {
    const lookupUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`;
    const lookupRes = await fetch(lookupUrl, { headers });
    if (!lookupRes.ok) {
        return { lookupAttributes: {}, polymorphicLookupAttributes: {} };
    }
    const lookupData: any = await lookupRes.json();
    const allLookups: Array<{ attribute: string; targets: string[] }> = (lookupData.value || [])
        .filter((a: any) => Array.isArray(a.Targets) && a.Targets.length > 0)
        .map((a: any) => ({ attribute: a.LogicalName, targets: a.Targets }));

    const uniqueTargets = Array.from(new Set(allLookups.flatMap(l => l.targets)));
    const entitySetByTarget = new Map<string, string>();
    await Promise.all(uniqueTargets.map(async target => {
        const entitySetName = await resolveEntitySetName(orgUrl, target, headers);
        if (entitySetName) {
            entitySetByTarget.set(target, entitySetName);
        }
    }));

    const lookupAttributes: Record<string, string> = {};
    const polymorphicLookupAttributes: Record<string, PolymorphicLookupTarget[]> = {};
    for (const { attribute, targets } of allLookups) {
        if (targets.length === 1) {
            const entitySetName = entitySetByTarget.get(targets[0]);
            if (entitySetName) {
                lookupAttributes[attribute] = entitySetName;
            }
        } else {
            const resolvedTargets: PolymorphicLookupTarget[] = targets
                .map(t => ({ logicalName: t, entitySetName: entitySetByTarget.get(t) }))
                .filter((t): t is PolymorphicLookupTarget => !!t.entitySetName);
            if (resolvedTargets.length > 0) {
                polymorphicLookupAttributes[attribute] = resolvedTargets;
            }
        }
    }
    return { lookupAttributes, polymorphicLookupAttributes };
}

export async function resolveEntitySetName(orgUrl: string, logicalName: string, headers: Record<string, string>): Promise<string | undefined> {
    const url = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')?$select=EntitySetName`;
    const res = await fetch(url, { headers });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    return data.EntitySetName;
}
