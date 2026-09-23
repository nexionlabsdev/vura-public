import { JWT } from 'google-auth-library';
import { describeGoogleDriveSchema } from '../schemaIntrospection';

describe('describeGoogleDriveSchema', () => {
    function jsonResponse(body: any) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
    }

    const fakeClient = { getRequestHeaders: async () => ({ Authorization: 'Bearer test-token' }) } as unknown as JWT;

    function mockFetch() {
        return jest.fn().mockImplementation(async (url: string) => {
            if (url.includes('/files?q=') && url.includes('fields=')) {
                return jsonResponse({
                    files: [{ id: 'f1', name: 'report.csv', mimeType: 'text/csv', size: '1024', modifiedTime: '2024-01-01T00:00:00Z' }]
                });
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
    }

    it('returns one pseudo-entity describing the file listing shape, with no relationships', async () => {
        const originalFetch = global.fetch;
        global.fetch = mockFetch();
        try {
            const schema = await describeGoogleDriveSchema(fakeClient, 'root');

            expect(schema.entities).toHaveLength(1);
            const entity = schema.entities[0];
            expect(entity.name).toBe('files');
            expect(entity.inferred).toBe(false);
            expect(entity.relationships).toEqual([]);
            expect(entity.fields.map(f => f.name)).toEqual(['name', 'mimeType', 'size', 'modifiedAt']);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
