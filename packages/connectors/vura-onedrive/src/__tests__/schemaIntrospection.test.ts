import { ConnectionProfile } from '@vura-data-os/core-sdk';
import { describeOneDriveSchema } from '../schemaIntrospection';
import { OneDriveProfileConfig } from '../graphClient';

describe('describeOneDriveSchema', () => {
    const profile: ConnectionProfile<OneDriveProfileConfig> = {
        id: 'od-1',
        name: 'test',
        kind: 'onedrive',
        config: { tenantId: 't', clientId: 'c', userPrincipalName: 'user@contoso.com' }
    };

    function jsonResponse(body: any) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
    }

    function mockFetch() {
        return jest.fn().mockImplementation(async (url: string) => {
            if (url.includes('/children') && url.includes('$select=name,size,lastModifiedDateTime,file')) {
                return jsonResponse({
                    value: [{ name: 'report.csv', size: 1024, lastModifiedDateTime: '2024-01-01T00:00:00Z', file: { mimeType: 'text/csv' } }]
                });
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
    }

    it('returns one pseudo-entity describing the file listing shape, with no relationships', async () => {
        const originalFetch = global.fetch;
        global.fetch = mockFetch();
        try {
            const schema = await describeOneDriveSchema(profile, 'test-token');

            expect(schema.entities).toHaveLength(1);
            const entity = schema.entities[0];
            expect(entity.name).toBe('files');
            expect(entity.inferred).toBe(false);
            expect(entity.relationships).toEqual([]);
            expect(entity.fields.map(f => f.name)).toEqual(['name', 'size', 'modifiedAt', 'mimeType']);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
