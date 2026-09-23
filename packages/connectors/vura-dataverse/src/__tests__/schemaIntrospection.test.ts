import { describeDataverseSchema } from '../schemaIntrospection';

describe('describeDataverseSchema', () => {
    const orgUrl = 'https://org.crm.dynamics.com';

    function jsonResponse(body: any) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
    }

    function mockFetch() {
        return jest.fn().mockImplementation(async (url: string) => {
            if (url.includes("EntityDefinitions(LogicalName='accounts')") && url.includes('$select=PrimaryIdAttribute,EntitySetName')) {
                return jsonResponse({ PrimaryIdAttribute: 'accountid', EntitySetName: 'accounts' });
            }
            if (url.includes("EntityDefinitions(LogicalName='accounts')/Attributes?")) {
                return jsonResponse({
                    value: [
                        { LogicalName: 'accountid', AttributeType: 'Uniqueidentifier', RequiredLevel: { Value: 'SystemRequired' } },
                        { LogicalName: 'name', AttributeType: 'String', RequiredLevel: { Value: 'None' } },
                        { LogicalName: 'createdon', AttributeType: 'DateTime', RequiredLevel: { Value: 'None' } },
                        { LogicalName: 'parentaccountid', AttributeType: 'Lookup', RequiredLevel: { Value: 'None' } }
                    ]
                });
            }
            if (url.includes("EntityDefinitions(LogicalName='accounts')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata")) {
                return jsonResponse({
                    value: [{ LogicalName: 'parentaccountid', Targets: ['account'] }]
                });
            }
            if (url.includes("EntityDefinitions(LogicalName='account')?$select=EntitySetName")) {
                return jsonResponse({ EntitySetName: 'accounts' });
            }
            if (url.includes("EntityDefinitions(LogicalName='account')?$select=PrimaryIdAttribute")) {
                return jsonResponse({ PrimaryIdAttribute: 'accountid' });
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
    }

    it('maps attributes to normalized fields and a foreign-key relationship', async () => {
        const originalFetch = global.fetch;
        global.fetch = mockFetch();
        try {
            const schema = await describeDataverseSchema(orgUrl, ['accounts'], 'test-token');

            expect(schema.entities).toHaveLength(1);
            const entity = schema.entities[0];
            expect(entity.name).toBe('accounts');
            expect(entity.inferred).toBe(false);

            const nameField = entity.fields.find(f => f.name === 'name');
            expect(nameField).toEqual({ name: 'name', type: 'string', nullable: true });

            const idField = entity.fields.find(f => f.name === 'accountid');
            expect(idField).toEqual({ name: 'accountid', type: 'guid', nullable: false });

            const dateField = entity.fields.find(f => f.name === 'createdon');
            expect(dateField?.type).toBe('datetime');

            expect(entity.relationships).toHaveLength(1);
            expect(entity.relationships[0]).toEqual({
                sourceField: 'parentaccountid',
                targetEntity: 'accounts',
                targetField: 'accountid',
                kind: 'foreign-key'
            });
        } finally {
            global.fetch = originalFetch;
        }
    });
});
