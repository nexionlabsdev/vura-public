import { describeSharePointListSchema } from '../schemaIntrospection';

describe('describeSharePointListSchema', () => {
    const siteUrl = 'https://contoso.sharepoint.com/sites/TeamSite';

    function jsonResponse(body: any) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
    }

    function mockFetch() {
        return jest.fn().mockImplementation(async (url: string) => {
            if (url.includes('/lists?$select=id,displayName')) {
                return jsonResponse({ value: [{ id: 'list-1', displayName: 'Documents' }] });
            }
            if (url.includes('/lists/list-1/columns')) {
                return jsonResponse({
                    value: [
                        { name: 'Title', required: true, text: {} },
                        { name: 'Amount', required: false, number: {} },
                        { name: 'DueDate', required: false, dateTime: {} },
                        { name: 'AssignedTo', required: false, personOrGroup: {} }
                    ]
                });
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
    }

    it('maps lists and columns to normalized entities with no relationships', async () => {
        const originalFetch = global.fetch;
        global.fetch = mockFetch();
        try {
            const schema = await describeSharePointListSchema(siteUrl, 'test-token');

            expect(schema.entities).toHaveLength(1);
            const entity = schema.entities[0];
            expect(entity.name).toBe('Documents');
            expect(entity.inferred).toBe(false);
            expect(entity.relationships).toEqual([]);

            expect(entity.fields).toEqual([
                { name: 'Title', type: 'string', nullable: false },
                { name: 'Amount', type: 'number', nullable: true },
                { name: 'DueDate', type: 'datetime', nullable: true },
                { name: 'AssignedTo', type: 'reference', nullable: true }
            ]);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
