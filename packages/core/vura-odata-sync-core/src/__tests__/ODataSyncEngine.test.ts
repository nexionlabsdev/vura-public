import { ODataSyncEngine } from '../ODataSyncEngine';
import { ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';

describe('Phase 9a: ODataSyncEngine', () => {
    let mockLogs: string[] = [];
    let mockLogger: ICellLogger;
    let mockEnv: IVuraEnvironment;

    beforeEach(() => {
        mockLogs = [];
        mockLogger = {
            logText: async (msg: string) => { mockLogs.push(msg); },
            logError: async (msg: string) => { mockLogs.push(`ERROR: ${msg}`); },
            replaceOutput: async (html: string) => { mockLogs.push(`OUTPUT: ${html}`); },
            logHtml: async (html: string) => { mockLogs.push(`HTML: ${html}`); },
            logJson: async (json: any) => { mockLogs.push(`JSON: ${JSON.stringify(json)}`); },
            logMultiple: async () => {},
            clearOutput: async () => {}
        };

        mockEnv = {
            storagePath: '/tmp/test',
            notebookDir: '/tmp/test',
            notebookId: 'test_nb',
            extensionPath: '/tmp/test',
            getConfig: (key, def) => def,
            getProfile: async () => undefined,
            getProfileSecret: async () => undefined,
            getConnectionProfile: async () => undefined,
            listConnectionProfiles: async () => [],
            getSecret: async () => undefined,
            setSecret: async () => {},
            deleteSecret: async () => {},
            runLocalQuery: async (sql: string) => [
                { id: '101', name: 'Widget A', price: 19.99, unused_col: 'skip_me' },
                { id: '102', name: 'Widget B', price: 29.99, unused_col: 'skip_me' }
            ],
            getPythonVenvPath: async () => undefined,
            setPythonVenvPath: async () => {},
            setMapping: async () => {}
        };
    });

    it('sends the upsert PATCH without an If-Match header, so it creates when the key does not already exist', async () => {
        let capturedBody = '';
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
                capturedBody += (init?.body || '') + '\n---\n';
                return {
                    ok: true,
                    status: 200,
                    text: async () => `--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n--changeset_x--\r\n--batch_x--`
                } as any;
            });

            await ODataSyncEngine.sendBatchRequest({
                endpointUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
                entitySetName: 'accounts',
                keyColumns: ['accountid'],
                keyType: 'primary',
                mode: 'upsert',
                records: [{ accountid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', name: 'Contoso' }],
                validColumns: ['accountid', 'name'],
                token: 'test_token',
                globalOffset: 0
            });

            expect(capturedBody).toContain('PATCH https://org.crm.dynamics.com/api/data/v9.2/accounts(3fa85f64-5717-4562-b3fc-2c963f66afa6) HTTP/1.1');
            expect(capturedBody).not.toContain('If-Match');
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('addresses a record by its bare (unquoted) GUID primary key, and OData-escapes alternate string keys', async () => {
        let capturedBody = '';
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
                capturedBody += (init?.body || '') + '\n---\n';
                return {
                    ok: true,
                    status: 200,
                    text: async () => `--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n--changeset_x--\r\n--batch_x--`
                } as any;
            });

            // Primary-key upsert: the id is a GUID-shaped string.
            await ODataSyncEngine.sendBatchRequest({
                endpointUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
                entitySetName: 'accounts',
                keyColumns: ['accountid'],
                keyType: 'primary',
                mode: 'upsert',
                records: [{ accountid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', name: 'Contoso' }],
                validColumns: ['accountid', 'name'],
                token: 'test_token',
                globalOffset: 0
            });

            expect(capturedBody).toContain(
                "PATCH https://org.crm.dynamics.com/api/data/v9.2/accounts(3fa85f64-5717-4562-b3fc-2c963f66afa6) HTTP/1.1"
            );
            expect(capturedBody).not.toContain("accounts('3fa85f64");

            capturedBody = '';

            // Alternate-key upsert: a string business key containing an embedded single quote.
            await ODataSyncEngine.sendBatchRequest({
                endpointUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
                entitySetName: 'accounts',
                keyColumns: ['accountnumber'],
                keyType: 'alternate',
                mode: 'upsert',
                records: [{ accountnumber: "O'Brien Ltd", name: "O'Brien Ltd" }],
                validColumns: ['accountnumber', 'name'],
                token: 'test_token',
                globalOffset: 0
            });

            expect(capturedBody).toContain("accounts(accountnumber='O''Brien Ltd')");
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('rewrites lookup columns as @odata.bind instead of a raw scalar value', async () => {
        let capturedBody = '';
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
                capturedBody += (init?.body || '') + '\n---\n';
                return {
                    ok: true,
                    status: 200,
                    text: async () => `--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n--changeset_x--\r\n--batch_x--`
                } as any;
            });

            await ODataSyncEngine.sendBatchRequest({
                endpointUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
                entitySetName: 'accounts',
                keyColumns: ['accountid'],
                keyType: 'primary',
                mode: 'upsert',
                records: [{
                    accountid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                    name: 'Contoso',
                    transactioncurrencyid: '11111111-1111-1111-1111-111111111111'
                }],
                validColumns: ['accountid', 'name', 'transactioncurrencyid'],
                lookupAttributes: { transactioncurrencyid: 'transactioncurrencies' },
                token: 'test_token',
                globalOffset: 0
            });

            expect(capturedBody).toContain('"transactioncurrencyid@odata.bind":"/transactioncurrencies(11111111-1111-1111-1111-111111111111)"');
            expect(capturedBody).not.toMatch(/"transactioncurrencyid":/);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('resolves the polymorphic ownerid lookup to systemuser by default, and leaves other polymorphic lookups unresolved', async () => {
        let capturedBody = '';
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
                capturedBody += (init?.body || '') + '\n---\n';
                return {
                    ok: true,
                    status: 200,
                    text: async () => `--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n--changeset_x--\r\n--batch_x--`
                } as any;
            });

            const ownerPolymorphicTargets = [
                { logicalName: 'systemuser', entitySetName: 'systemusers' },
                { logicalName: 'team', entitySetName: 'teams' }
            ];
            const customerPolymorphicTargets = [
                { logicalName: 'account', entitySetName: 'accounts' },
                { logicalName: 'contact', entitySetName: 'contacts' }
            ];

            await ODataSyncEngine.sendBatchRequest({
                endpointUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
                entitySetName: 'accounts',
                keyColumns: ['accountid'],
                keyType: 'primary',
                mode: 'upsert',
                records: [{
                    accountid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                    ownerid: '22222222-2222-2222-2222-222222222222',
                    // No local column can tell us which entity this belongs to — a genuinely
                    // ambiguous polymorphic lookup other than ownerid stays unresolved.
                    customerid: '44444444-4444-4444-4444-444444444444'
                }],
                validColumns: ['accountid', 'ownerid', 'customerid'],
                polymorphicLookupAttributes: { ownerid: ownerPolymorphicTargets, customerid: customerPolymorphicTargets },
                token: 'test_token',
                globalOffset: 0
            });

            expect(capturedBody).toContain('"ownerid@odata.bind":"/systemusers(22222222-2222-2222-2222-222222222222)"');
            expect(capturedBody).toContain('"customerid":"44444444-4444-4444-4444-444444444444"');
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('excludes attributes not writable for the current operation (per real EntityDefinitions metadata), even when the name looks legitimate', async () => {
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string) => {
                if (url.endsWith('/$batch')) {
                    return {
                        ok: true,
                        status: 200,
                        text: async () => `--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n--changeset_x--\r\n--batch_x--`
                    } as any;
                }
                return { ok: false, status: 404 } as any;
            });

            const result = await ODataSyncEngine.sync({
                baseUrl: 'https://org.crm.dynamics.com',
                getToken: async () => 'test_bearer_token',
                source: 'my_local_table',
                target: 'accounts',
                mode: 'upsert',
                apiPathPrefix: '/api/data/v9.2',
                fetchMetadata: async () => ({
                    primaryIdAttribute: 'accountid',
                    entitySetName: 'accounts',
                    alternateKeys: [],
                    // 'owneridtype' is a REAL Dataverse attribute name (not a typo/unmapped
                    // column) — it exists in metadata but is read-only, so it must be excluded
                    // by writability, not by a "do we recognize this name" check.
                    attributes: ['accountid', 'name', 'owneridtype'],
                    attributeWritability: {
                        accountid: { validForCreate: false, validForUpdate: false },
                        name: { validForCreate: true, validForUpdate: true },
                        owneridtype: { validForCreate: false, validForUpdate: false }
                    }
                }),
                env: {
                    ...mockEnv,
                    runLocalQuery: async () => [{ accountid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', name: 'Contoso', owneridtype: 'systemuser' }]
                },
                logger: mockLogger
            });

            expect(result.skippedColumns).toContain('owneridtype');
            expect(mockLogs.some(l => l.includes('non-writable column'))).toBe(true);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('parses batch response correctly', () => {
        const responseText = `--batch_123
Content-Type: multipart/mixed; boundary=changeset_123

--changeset_123
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 1

HTTP/1.1 204 No Content
OData-Version: 4.0

--changeset_123
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 2

HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": {"code": "0x80040265", "message": "Duplicate key value."}}

--changeset_123--
--batch_123--`;

        const originalRecords = [{ id: '101' }, { id: '102' }];
        const parsed = ODataSyncEngine.parseBatchResponse(responseText, originalRecords, ['id'], 0);

        expect(parsed.successCount).toBe(1);
        expect(parsed.batchErrors).toHaveLength(1);
        expect(parsed.batchErrors[0].recordIndex).toBe(1);
        expect(parsed.batchErrors[0].recordKey).toBe('id=102');
        expect(parsed.batchErrors[0].error).toContain('Duplicate key value');
    });

    it('executes full sync with custom fetchMetadata and sendBatchRequest mock', async () => {
        const originalFetch = global.fetch;
        try {
            global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
                if (url.endsWith('/$batch')) {
                    const batchResponseBody = `--batch_test
Content-Type: multipart/mixed; boundary=changeset_test

--changeset_test
Content-Type: application/http
Content-ID: 1

HTTP/1.1 204 No Content

--changeset_test
Content-Type: application/http
Content-ID: 2

HTTP/1.1 204 No Content

--changeset_test--
--batch_test--`;
                    return {
                        ok: true,
                        status: 200,
                        text: async () => batchResponseBody
                    } as any;
                }
                return { ok: false, status: 404 } as any;
            });

            const result = await ODataSyncEngine.sync({
                baseUrl: 'https://odata.example.com',
                getToken: async () => 'test_bearer_token',
                source: 'my_local_table',
                target: 'Products',
                mode: 'upsert',
                batchSize: 50,
                apiPathPrefix: '/v1',
                fetchMetadata: async () => ({
                    primaryIdAttribute: 'id',
                    entitySetName: 'Products',
                    alternateKeys: [],
                    attributes: ['id', 'name', 'price']
                }),
                env: mockEnv,
                logger: mockLogger
            });

            expect(result.totalRecords).toBe(2);
            expect(result.totalSuccess).toBe(2);
            expect(result.skippedColumns).toContain('unused_col');
            expect(result.errors).toHaveLength(0);

            expect(mockLogs.some(l => l.includes('Key resolved: "id"'))).toBe(true);
            expect(mockLogs.some(l => l.includes('Skipping 1 unmapped/non-writable column'))).toBe(true);
            expect(mockLogs.some(l => l.includes('OUTPUT:'))).toBe(true);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
