import { NormalizedEntity, NormalizedField, NormalizedSchema } from '@vura-data-os/core-sdk';
import { graphFetch } from './graphDriveClient';

/** Splits a SharePoint site URL into the Graph `{hostname}:/{site-path}` pair,
 *  matching graphDriveClient.ts's private siteSegment() helper exactly (kept
 *  local here rather than exporting that one, since it's a one-line format
 *  helper with no other state). */
function siteSegment(siteUrl: string): string {
    const url = new URL(siteUrl);
    const sitePath = url.pathname.replace(/\/+$/, '');
    return `${url.hostname}:${sitePath}`;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function mapColumnType(column: any): NormalizedField['type'] {
    if (column.text || column.note) return 'string';
    if (column.number || column.currency) return 'number';
    if (column.boolean) return 'boolean';
    if (column.dateTime) return 'datetime';
    if (column.lookup || column.personOrGroup) return 'reference';
    return 'unknown';
}

/** Uses Microsoft Graph's Lists API (not SharePoint's legacy `_api/web/lists`
 *  REST endpoint) because this connector's only acquired token is Graph-scoped
 *  (see graphDriveClient.ts's getGraphToken) — Graph exposes the same list +
 *  column metadata without needing a second, SharePoint-scoped auth path. */
export async function describeSharePointListSchema(siteUrl: string, token: string): Promise<NormalizedSchema> {
    const segment = siteSegment(siteUrl);
    const listsRes = await graphFetch(`${GRAPH_BASE}/sites/${segment}/lists?$select=id,displayName`, token);
    const listsData: any = await listsRes.json();

    const entities: NormalizedEntity[] = [];
    for (const list of listsData.value || []) {
        const columnsRes = await graphFetch(
            `${GRAPH_BASE}/sites/${segment}/lists/${list.id}/columns?$select=name,required,text,note,number,currency,boolean,dateTime,lookup,personOrGroup`,
            token
        );
        const columnsData: any = await columnsRes.json();
        const fields: NormalizedField[] = (columnsData.value || []).map((col: any) => ({
            name: col.name,
            type: mapColumnType(col),
            nullable: !col.required
        }));

        entities.push({
            name: list.displayName,
            fields,
            relationships: [],
            inferred: false
        });
    }

    return { entities };
}
