import { fetchEntityMetadata } from '../syncDataverseHandler';

/**
 * Reproduces the exact scenario from samples/dataverse_sample.flownb: syncing into a custom
 * entity (`cr21c_accountclone`) whose seed table carries `ownerid` (a polymorphic lookup) and
 * `transactioncurrencyid` (a single-target lookup). The regression this guards against: the
 * `owneridtype` companion attribute is a real, listed Dataverse attribute that the metadata API
 * itself reports as IsValidForCreate/IsValidForUpdate = true — but Dataverse's Web API always
 * rejects a direct write to it (0x80048d19, "Invalid property 'owneridtype'"), since it's an
 * `AttributeType: 'EntityName'` discriminator set implicitly by whichever entity `ownerid`'s
 * own @odata.bind points at. fetchEntityMetadata must mark it non-writable regardless of what
 * IsValidForCreate/IsValidForUpdate say.
 */
describe('fetchEntityMetadata — cr21c_accountclone (ownerid/owneridtype/transactioncurrencyid)', () => {
    const orgUrl = 'https://org.crm.dynamics.com';

    function mockFetch() {
        return jest.fn().mockImplementation(async (url: string) => {
            if (url.includes("EntityDefinitions(LogicalName='cr21c_accountclone')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata")) {
                return jsonResponse({
                    value: [
                        { LogicalName: 'transactioncurrencyid', Targets: ['transactioncurrency'] },
                        { LogicalName: 'ownerid', Targets: ['systemuser', 'team'] },
                        { LogicalName: 'owningbusinessunit', Targets: ['businessunit'] }
                    ]
                });
            }
            if (url.includes("EntityDefinitions(LogicalName='cr21c_accountclone')/Attributes")) {
                return jsonResponse({
                    value: [
                        { LogicalName: 'cr21c_accountcloneid', AttributeType: 'Uniqueidentifier', IsValidForCreate: true, IsValidForUpdate: false },
                        { LogicalName: 'cr21c_accountname', AttributeType: 'String', IsValidForCreate: true, IsValidForUpdate: true },
                        { LogicalName: 'transactioncurrencyid', AttributeType: 'Lookup', IsValidForCreate: true, IsValidForUpdate: true },
                        { LogicalName: 'exchangerate', AttributeType: 'Decimal', IsValidForCreate: true, IsValidForUpdate: true },
                        { LogicalName: 'ownerid', AttributeType: 'Owner', IsValidForCreate: true, IsValidForUpdate: true },
                        // The crux of the bug: Dataverse itself reports this as writable, yet rejects direct writes to it.
                        { LogicalName: 'owneridtype', AttributeType: 'EntityName', IsValidForCreate: true, IsValidForUpdate: true },
                        { LogicalName: 'owningbusinessunit', AttributeType: 'Lookup', IsValidForCreate: true, IsValidForUpdate: false },
                        { LogicalName: 'createdon', AttributeType: 'DateTime', IsValidForCreate: false, IsValidForUpdate: false },
                        { LogicalName: 'statecode', AttributeType: 'State', IsValidForCreate: true, IsValidForUpdate: true }
                    ]
                });
            }
            if (url.includes("EntityDefinitions(LogicalName='cr21c_accountclone')/Keys")) {
                return jsonResponse({ value: [] });
            }
            if (url.includes("EntityDefinitions(LogicalName='cr21c_accountclone')?")) {
                return jsonResponse({ PrimaryIdAttribute: 'cr21c_accountcloneid', EntitySetName: 'cr21c_accountclones' });
            }
            if (url.includes("EntityDefinitions(LogicalName='transactioncurrency')?")) {
                return jsonResponse({ EntitySetName: 'transactioncurrencies' });
            }
            if (url.includes("EntityDefinitions(LogicalName='systemuser')?")) {
                return jsonResponse({ EntitySetName: 'systemusers' });
            }
            if (url.includes("EntityDefinitions(LogicalName='team')?")) {
                return jsonResponse({ EntitySetName: 'teams' });
            }
            if (url.includes("EntityDefinitions(LogicalName='businessunit')?")) {
                return jsonResponse({ EntitySetName: 'businessunits' });
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
    }

    function jsonResponse(body: any) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
    }

    it('marks owneridtype non-writable even though Dataverse reports IsValidForCreate/IsValidForUpdate = true', async () => {
        const originalFetch = global.fetch;
        global.fetch = mockFetch();
        try {
            const metadata = await fetchEntityMetadata(orgUrl, 'cr21c_accountclone', 'test_token');

            expect(metadata.attributeWritability?.['owneridtype']).toEqual({ validForCreate: false, validForUpdate: false });

            // Sanity: an ordinary lookup and an ordinary writable field are untouched.
            expect(metadata.attributeWritability?.['cr21c_accountname']).toEqual({ validForCreate: true, validForUpdate: true });
            expect(metadata.attributeWritability?.['createdon']).toEqual({ validForCreate: false, validForUpdate: false });

            // Single-target lookup resolves to its entity set.
            expect(metadata.lookupAttributes?.['transactioncurrencyid']).toBe('transactioncurrencies');
            expect(metadata.lookupAttributes?.['owningbusinessunit']).toBe('businessunits');

            // Polymorphic lookup resolves both possible targets.
            expect(metadata.polymorphicLookupAttributes?.['ownerid']).toEqual(
                expect.arrayContaining([
                    { logicalName: 'systemuser', entitySetName: 'systemusers' },
                    { logicalName: 'team', entitySetName: 'teams' }
                ])
            );
        } finally {
            global.fetch = originalFetch;
        }
    });
});
