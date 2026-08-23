import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { startServer } from '../commands/serveCommand';
import { sidecarPool } from '../services/sidecarPool';
import { DuckDbManager } from '../services/duckDbManager';

describe('Vura Serve Flow Discovery & API Endpoints', () => {
    let tempDir: string;
    let server: http.Server;
    let port: number;

    jest.setTimeout(60000);

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-serve-flows-test-'));

        // Create a root flow
        await fs.writeFile(
            path.join(tempDir, 'root_flow.flownb'),
            '- kind: 2\n  language: sql\n  value: SELECT 1 as val;\n',
            'utf8'
        );

        // Create a subfolder flow (e.g. samples/use_case.flownb) with version 1 format
        const subDir = path.join(tempDir, 'samples');
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(
            path.join(subDir, 'use_case.flownb'),
            'version: 1\ncells:\n  - kind: 2\n    language: http-input\n    value: \'{"type":"object"}\'\n  - kind: 2\n    language: sql\n    value: SELECT 2 as val;\n    metadata:\n      vura_is_http_output: true\n',
            'utf8'
        );

        port = 9876 + Math.floor(Math.random() * 100);
        server = await startServer(port, tempDir);
    }, 30000);

    afterAll(async () => {
        try { sidecarPool.disposeAll(); } catch {}
        try { DuckDbManager.disposeAll(); } catch {}
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    }, 30000);

    it('recursively discovers root and nested .flownb files in /api/flows', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/flows`);
        expect(res.status).toBe(200);
        const flows = await res.json();

        const flowNames = flows.map((f: any) => f.name);
        expect(flowNames).toContain('root_flow.flownb');
        expect(flowNames).toContain('samples/use_case.flownb');
    });

    it('triggers nested flow via wildcard route /flow/trigger/samples/use_case.flownb', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/flow/trigger/samples/use_case.flownb`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res.status).toBe(200);
    }, 15000);

    it('validates http-input schema with required query.name without DuckDBStructValue error', async () => {
        await fs.writeFile(
            path.join(tempDir, 'schema_test.flownb'),
            'version: 1\ncells:\n  - kind: 2\n    language: http-input\n    value: \'{"type":"object","properties":{"query":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}},"required":["query"]}\'\n  - kind: 2\n    language: sql\n    value: SELECT query.name as user_name, body.age as user_age FROM http_request;\n',
            'utf8'
        );
        const res = await fetch(`http://127.0.0.1:${port}/flow/trigger/schema_test.flownb?name=John`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ age: 30, name: 'John' })
        });
        expect(res.status).toBe(200);
    }, 15000);

    it('serves a single .flownb file path directly (e.g. vura serve ./samples/use_case.flownb)', async () => {
        const singleFilePath = path.join(tempDir, 'samples', 'use_case.flownb');
        const singlePort = port + 10;
        const singleServer = await startServer(singlePort, singleFilePath);

        const res = await fetch(`http://127.0.0.1:${singlePort}/api/flows`);
        expect(res.status).toBe(200);
        const flows = await res.json();
        expect(flows).toHaveLength(1);
        expect(flows[0].name).toBe('use_case.flownb');

        await new Promise<void>((resolve) => singleServer.close(() => resolve()));
    });

    it('executes paginated 10k dataset flow via HTTP trigger with page and page_size parameters', async () => {
        const samplePath = path.resolve(__dirname, '../../../../samples/paginated_flow_sample.flownb');
        const pPort = port + 20;
        const pServer = await startServer(pPort, samplePath);

        const res = await fetch(`http://127.0.0.1:${pPort}/flow/trigger/paginated_flow_sample.flownb?page=2&page_size=5`);
        if (res.status !== 200) {
            console.error('Trigger Response Body:', await res.clone().text());
        }
        expect(res.status).toBe(200);
        const json = await res.json();

        expect(json.status).toBe('success');
        expect(json.pagination).toBeDefined();
        expect(json.pagination.current_page).toBe(2);
        expect(json.pagination.page_size).toBe(5);
        expect(json.pagination.total_count ?? json.pagination.total_records).toBe(10000);
        expect(json.pagination.total_pages).toBe(2000);
        expect(json.data).toHaveLength(5);
        expect(json.data[0].id).toBe(6);

        await new Promise<void>((resolve) => pServer.close(() => resolve()));
    }, 45000);
});
