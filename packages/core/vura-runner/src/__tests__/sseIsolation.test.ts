import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { startServer } from '../commands/serveCommand';
import { sidecarPool } from '../services/sidecarPool';
import { DuckDbManager } from '../services/duckDbManager';

describe('SSE Concurrent-Run Isolation Test', () => {
    let tempDir: string;
    let server: http.Server;
    let port: number;

    jest.setTimeout(30000);

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-sse-isolation-test-'));

        // Create flow 1
        await fs.writeFile(
            path.join(tempDir, 'flow1.flownb'),
            '- kind: 2\n  language: sql\n  value: SELECT 101 as val1;\n',
            'utf8'
        );

        // Create flow 2
        await fs.writeFile(
            path.join(tempDir, 'flow2.flownb'),
            '- kind: 2\n  language: sql\n  value: SELECT 202 as val2;\n',
            'utf8'
        );

        port = 9950 + Math.floor(Math.random() * 50);
        server = await startServer(port, tempDir);
    }, 15000);

    afterAll(async () => {
        try { sidecarPool.disposeAll(); } catch {}
        try { DuckDbManager.disposeAll(); } catch {}
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    }, 15000);

    it('subscribes to SSE stream for runId1 and asserts zero events received from concurrent runId2', async () => {
        // Trigger run 1 asynchronously
        const res1 = await fetch(`http://127.0.0.1:${port}/flow/trigger/flow1.flownb?async=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res1.status).toBe(202);
        const { runId: runId1 } = await res1.json();
        expect(runId1).toBeDefined();

        // Connect to SSE stream filtered specifically to runId1
        const eventsForRun1: any[] = [];
        const controller = new AbortController();
        const ssePromise = (async () => {
            try {
                const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?runId=${runId1}`, {
                    signal: controller.signal
                });
                const reader = sseRes.body?.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (reader) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';
                    for (const chunk of lines) {
                        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
                        if (dataLine) {
                            try {
                                const parsed = JSON.parse(dataLine.replace('data: ', ''));
                                eventsForRun1.push(parsed);
                            } catch {}
                        }
                    }
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    throw err;
                }
            }
        })();

        // Give SSE listener a moment to establish
        await new Promise(r => setTimeout(r, 200));

        // Trigger run 2 asynchronously
        const res2 = await fetch(`http://127.0.0.1:${port}/flow/trigger/flow2.flownb?async=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res2.status).toBe(202);
        const { runId: runId2 } = await res2.json();
        expect(runId2).toBeDefined();

        // Wait for executions to finish
        await new Promise(r => setTimeout(r, 1500));

        // Abort SSE connection
        controller.abort();
        await ssePromise;

        // Verify events were captured for runId1
        expect(eventsForRun1.length).toBeGreaterThan(0);

        // Assert zero events received belong to runId2
        const runId2Events = eventsForRun1.filter(e => (e.runId === runId2 || e.id === runId2));
        expect(runId2Events).toEqual([]);

        // Assert all events in stream belong to runId1
        eventsForRun1.forEach(e => {
            const eventRunId = e.runId || e.id;
            expect(eventRunId).toBe(runId1);
        });
    });
});
