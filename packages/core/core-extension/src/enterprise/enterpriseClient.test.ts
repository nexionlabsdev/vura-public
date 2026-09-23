import { EnterpriseClient, EnterpriseError, FetchLike, describeFailure, describePublish, readEnterpriseConfig, workflowFromRegistryPath } from './enterpriseClient';

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: any };

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): { fetch: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
        calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
        const r = routes[`${init?.method ?? 'GET'} ${new URL(url).pathname}`];
        if (!r) { return { ok: false, status: 500, text: async () => JSON.stringify({ title: `unmocked ${init?.method} ${url}` }) }; }
        return { ok: r.status < 400, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
    };
    return { fetch, calls };
}

const cfg = { apiUrl: 'https://vura.example', token: 'vst_secret_token' };

describe('readEnterpriseConfig', () => {
    it('is off without an API URL, and says why', () => {
        expect(readEnterpriseConfig('', { VURA_API_TOKEN: 'x' })).toEqual({ problem: expect.stringContaining('vura.enterprise.apiUrl') });
    });
    it('rejects a non-http URL and a missing token', () => {
        expect(readEnterpriseConfig('ftp://x', { VURA_API_TOKEN: 'x' })).toHaveProperty('problem');
        expect(readEnterpriseConfig('https://x', {})).toEqual({ problem: expect.stringContaining('VURA_API_TOKEN') });
    });
    it('normalizes the URL and takes the token only from the environment', () => {
        expect(readEnterpriseConfig(' https://vura.example/// ', { VURA_API_TOKEN: ' vst_abc ' })).toEqual({ apiUrl: 'https://vura.example', token: 'vst_abc' });
    });
});

describe('EnterpriseClient.publish', () => {
    it('creates the workflow when it is new, then publishes a version', async () => {
        const { fetch, calls } = fakeFetch({
            'GET /api/v1/workflows': { status: 200, body: { items: [] } },
            'POST /api/v1/workflows': { status: 201, body: { id: 'w1' } },
            'POST /api/v1/workflows/w1/versions': { status: 201, body: { seq: 1, created: true } },
        });
        const r = await new EnterpriseClient(cfg, fetch).publish('sync', 'crm', 'version: 1', 'dev');
        expect(r).toEqual({ workflowId: 'w1', seq: 1, created: true });
        expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /api/v1/workflows', 'POST /api/v1/workflows', 'POST /api/v1/workflows/w1/versions']);
        expect(calls[2].body).toEqual({ flownb: 'version: 1', environment: 'dev' });
        expect(calls.every((c) => c.headers?.Authorization === 'Bearer vst_secret_token')).toBe(true);
    });

    it('reuses an existing workflow with the same name and folder', async () => {
        const { fetch, calls } = fakeFetch({
            'GET /api/v1/workflows': { status: 200, body: { items: [{ id: 'w9', name: 'sync', folder: 'crm', latest_seq: 2 }, { id: 'w8', name: 'sync', folder: 'other', latest_seq: 1 }] } },
            'POST /api/v1/workflows/w9/versions': { status: 200, body: { seq: 2, created: false } },
        });
        const r = await new EnterpriseClient(cfg, fetch).publish('sync', 'crm', 'x');
        expect(r).toEqual({ workflowId: 'w9', seq: 2, created: false });
        expect(calls.some((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v1/workflows')).toBe(false);
        expect(describePublish(r)).toContain('already published as version 2');
    });

    it('surfaces validation findings verbatim (422)', async () => {
        const { fetch } = fakeFetch({
            'GET /api/v1/workflows': { status: 200, body: { items: [{ id: 'w1', name: 'n', folder: '', latest_seq: 0 }] } },
            'POST /api/v1/workflows/w1/versions': { status: 422, body: { title: 'Validation failed', errors: [{ code: 'unsupported-language', message: 'Unsupported cell language "cobol".', cell_index: 3 }] } },
        });
        const err = await new EnterpriseClient(cfg, fetch).publish('n', '', 'bad').catch((e) => e);
        expect(err).toBeInstanceOf(EnterpriseError);
        expect(err.status).toBe(422);
        expect(describeFailure(err)).toContain('unsupported-language (cell 3)');
    });

    it('reports a missing build worker honestly (503) and never claims success', async () => {
        const { fetch } = fakeFetch({
            'GET /api/v1/workflows': { status: 200, body: { items: [{ id: 'w1', name: 'n', folder: '', latest_seq: 0 }] } },
            'POST /api/v1/workflows/w1/versions': { status: 503, body: { title: 'No build worker available', detail: 'none is available right now' } },
        });
        const err = await new EnterpriseClient(cfg, fetch).publish('n', '', 'x').catch((e) => e);
        expect(err.status).toBe(503);
        expect(describeFailure(err)).toContain('No build worker available: none is available right now');
    });

    it('never leaks the token into an error message', async () => {
        const { fetch } = fakeFetch({ 'GET /api/v1/workflows': { status: 401, body: { title: 'Unauthorized' } } });
        const err = await new EnterpriseClient(cfg, fetch).publish('n', '', 'x').catch((e) => e);
        expect(describeFailure(err)).not.toContain('vst_secret_token');
        expect(String(err.stack)).not.toContain('vst_secret_token');
    });
});

describe('workflowFromRegistryPath', () => {
    it('derives folder and name from the mirrored registry layout', () => {
        expect(workflowFromRegistryPath('/home/coder/project/registry/crm/eu/sync-accounts/v3.flownb')).toEqual({ folder: 'crm/eu', name: 'sync-accounts' });
        expect(workflowFromRegistryPath('/p/registry/sync/latest.flownb')).toEqual({ folder: '', name: 'sync' });
        expect(workflowFromRegistryPath('C:\\work\\registry\\crm\\sync\\v1.flownb')).toEqual({ folder: 'crm', name: 'sync' });
    });
    it('returns undefined for files outside a registry tree', () => {
        expect(workflowFromRegistryPath('/home/coder/project/drafts/x.flownb')).toBeUndefined();
        expect(workflowFromRegistryPath('/home/coder/project/registry/x.flownb')).toBeUndefined(); // no workflow directory
    });
    it('uses the innermost registry directory when the path contains several', () => {
        expect(workflowFromRegistryPath('/registry/backup/registry/a/b/v1.flownb')).toEqual({ folder: 'a', name: 'b' });
    });
});
