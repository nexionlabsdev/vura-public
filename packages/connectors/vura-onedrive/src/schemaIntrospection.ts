import { ConnectionProfile, NormalizedSchema } from '@vura-data-os/core-sdk';
import { graphListChildrenUrl, graphFetch, OneDriveProfileConfig } from './graphClient';

/** OneDrive is a pure file/folder store with no structured-schema concept -
 *  describeSchema() returns one pseudo-entity describing the file listing
 *  shape itself, never guessing at relationships. */
export async function describeOneDriveSchema(
    profile: ConnectionProfile<OneDriveProfileConfig>,
    token: string,
    rootPath: string = ''
): Promise<NormalizedSchema> {
    // Fetched (not just assumed) so a bad connection/rootPath surfaces here rather
    // than silently returning a schema for a folder that isn't actually reachable.
    const url = `${graphListChildrenUrl(profile, rootPath)}?$select=name,size,lastModifiedDateTime,file`;
    await graphFetch(url, token);

    return {
        entities: [
            {
                name: 'files',
                fields: [
                    { name: 'name', type: 'string', nullable: false },
                    { name: 'size', type: 'number', nullable: true },
                    { name: 'modifiedAt', type: 'datetime', nullable: true },
                    { name: 'mimeType', type: 'string', nullable: true }
                ],
                relationships: [],
                inferred: false
            }
        ]
    };
}
