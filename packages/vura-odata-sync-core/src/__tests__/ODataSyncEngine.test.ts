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
            expect(mockLogs.some(l => l.includes('Skipping 1 unmapped column'))).toBe(true);
            expect(mockLogs.some(l => l.includes('OUTPUT:'))).toBe(true);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
