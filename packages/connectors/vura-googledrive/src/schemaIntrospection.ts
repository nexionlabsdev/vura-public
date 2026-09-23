import { JWT } from 'google-auth-library';
import { NormalizedSchema } from '@vura-data-os/core-sdk';
import { driveFetch, DRIVE_BASE } from './driveClient';

/** Google Drive is a pure file/folder store with no structured-schema concept -
 *  describeSchema() returns one pseudo-entity describing the file listing
 *  shape itself, never guessing at relationships. Reuses the exact same
 *  fields/query shape already used by listFiles() in index.ts. */
export async function describeGoogleDriveSchema(client: JWT, folderId: string = 'root'): Promise<NormalizedSchema> {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime)');
    // Fetched (not just assumed) so a bad connection/folderId surfaces here rather
    // than silently returning a schema for a folder that isn't actually reachable.
    await driveFetch(client, `${DRIVE_BASE}/files?q=${q}&fields=${fields}`);

    return {
        entities: [
            {
                name: 'files',
                fields: [
                    { name: 'name', type: 'string', nullable: false },
                    { name: 'mimeType', type: 'string', nullable: false },
                    { name: 'size', type: 'number', nullable: true },
                    { name: 'modifiedAt', type: 'datetime', nullable: true }
                ],
                relationships: [],
                inferred: false
            }
        ]
    };
}
