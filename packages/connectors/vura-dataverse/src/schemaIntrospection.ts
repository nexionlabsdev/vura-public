import { NormalizedEntity, NormalizedField, NormalizedRelationship, NormalizedSchema } from '@vura-data-os/core-sdk';
import { resolveEntitySetName } from './syncDataverseHandler';

/** Entities introspected by default when a Dataverse connection has no explicit
 *  entity list configured — Dataverse profiles are org-level, not entity-level,
 *  and this mirrors the same example set already used by this package's own
 *  UI picker (see index.ts's getUIActions quickpick options). */
export const DEFAULT_DATAVERSE_ENTITIES = ['accounts', 'contacts', 'leads'];

function mapAttributeType(attributeType: string | undefined): NormalizedField['type'] {
    switch (attributeType) {
        case 'String':
        case 'Memo':
            return 'string';
        case 'Integer':
        case 'BigInt':
        case 'Decimal':
        case 'Double':
        case 'Money':
            return 'number';
        case 'Boolean':
            return 'boolean';
        case 'DateTime':
            return 'datetime';
        case 'Uniqueidentifier':
            return 'guid';
        case 'Lookup':
        case 'Owner':
        case 'Customer':
            return 'reference';
        default:
            return 'unknown';
    }
}

async function describeOneEntity(
    orgUrl: string,
    logicalName: string,
    headers: Record<string, string>
): Promise<NormalizedEntity> {
    const defUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')?$select=PrimaryIdAttribute,EntitySetName`;
    const defRes = await fetch(defUrl, { headers });
    if (!defRes.ok) {
        const body = await defRes.text();
        throw new Error(`Failed to fetch entity definition for "${logicalName}": ${defRes.status} ${defRes.statusText}\n${body}`);
    }
    const defData: any = await defRes.json();
    const entitySetName: string = defData.EntitySetName;

    const attrUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName,AttributeType,RequiredLevel`;
    const attrRes = await fetch(attrUrl, { headers });
    const fields: NormalizedField[] = [];
    if (attrRes.ok) {
        const attrData: any = await attrRes.json();
        for (const a of attrData.value || []) {
            const requiredLevelValue = a.RequiredLevel?.Value;
            const nullable = requiredLevelValue === undefined ? true : requiredLevelValue === 'None';
            fields.push({
                name: a.LogicalName,
                type: mapAttributeType(a.AttributeType),
                nullable
            });
        }
    }

    const lookupUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`;
    const lookupRes = await fetch(lookupUrl, { headers });
    const relationships: NormalizedRelationship[] = [];
    if (lookupRes.ok) {
        const lookupData: any = await lookupRes.json();
        for (const a of lookupData.value || []) {
            const targets: string[] = Array.isArray(a.Targets) ? a.Targets : [];
            const targetLogicalName = targets[0];
            if (!targetLogicalName) continue;
            const targetEntitySetName = await resolveEntitySetName(orgUrl, targetLogicalName, headers);
            if (!targetEntitySetName) continue;
            const targetDefUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${targetLogicalName}')?$select=PrimaryIdAttribute`;
            const targetDefRes = await fetch(targetDefUrl, { headers });
            const targetPrimaryId = targetDefRes.ok ? (await targetDefRes.json() as any).PrimaryIdAttribute : undefined;
            relationships.push({
                sourceField: a.LogicalName,
                targetEntity: targetEntitySetName,
                targetField: targetPrimaryId || 'id',
                kind: 'foreign-key'
            });
        }
    }

    return { name: entitySetName || logicalName, fields, relationships, inferred: false };
}

export async function describeDataverseSchema(
    orgUrl: string,
    logicalNames: string[],
    token: string
): Promise<NormalizedSchema> {
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
    };

    const entities = await Promise.all(logicalNames.map(name => describeOneEntity(orgUrl, name, headers)));
    return { entities };
}
