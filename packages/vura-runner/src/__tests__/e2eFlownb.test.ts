import { VuraRunner } from '../runner';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.setTimeout(15000);

describe('VuraRunner End-to-End Local Polyglot Notebook (.flownb)', () => {
    let tempDir: string;
    let env: IVuraEnvironment;
    let loggerOutput: { text: string[]; html: string[]; json: string[] };
    let mockLogger: ICellLogger;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-e2e-flownb-'));
        
        // Pre-create package.json to prevent runner from invoking network npm install in tests
        await fs.writeFile(
            path.join(tempDir, 'package.json'),
            JSON.stringify({ name: 'vura-test-storage', private: true }),
            'utf8'
        );

        loggerOutput = { text: [], html: [], json: [] };

        env = {
            storagePath: tempDir,
            notebookDir: tempDir,
            notebookId: `e2e-${Date.now()}`,
            extensionPath: tempDir,
            getConfig: (key: string, defaultValue: any) => defaultValue,
            getProfile: async () => undefined,
            getProfileSecret: async () => undefined,
            getSecret: async () => undefined,
            setSecret: async () => undefined,
            deleteSecret: async () => undefined,
            runLocalQuery: async (sql: string) => {
                const mgr = await DuckDbManager.getInstance(env);
                return mgr.runQuery(sql);
            },
            getPythonVenvPath: async () => undefined,
            setPythonVenvPath: async () => undefined,
            setMapping: async () => undefined,
        };

        mockLogger = {
            logText: async (text: string) => { loggerOutput.text.push(text); },
            logError: async (err: string) => { loggerOutput.text.push(`ERROR: ${err}`); },
            logHtml: async (html: string) => { loggerOutput.html.push(html); },
            logJson: async (json: string) => { loggerOutput.json.push(json); },
            replaceOutput: async (out: string) => { loggerOutput.html.push(out); },
            logMultiple: async () => {},
            clearOutput: async () => { loggerOutput = { text: [], html: [], json: [] }; }
        };
    });

    afterEach(async () => {
        try {
            const dbMgr = await DuckDbManager.getInstance(env);
            dbMgr.dispose();
        } catch {}
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('executes a self-contained multi-cell notebook (SQL, JSON Compose, Vega-Lite, Nunjucks) cleanly', async () => {
        const runner = new VuraRunner(env);

        const cells: FlownbCell[] = [
            // Cell 0: SQL - Ingest local seed data into DuckDB
            {
                kind: 2,
                language: 'sql',
                value: `
                    CREATE TABLE local_inventory AS
                    SELECT * FROM (
                        VALUES
                            (1, 'Laptop Stand', 'Hardware', 15, 29.99),
                            (2, 'Mechanical Keyboard', 'Hardware', 8, 89.99),
                            (3, 'USB-C Cable', 'Accessories', 50, 9.99)
                    ) AS t(id, product, category, quantity, price);
                `,
                metadata: { label: 'ingest_sql' }
            },
            // Cell 1: SQL - Query and calculate totals
            {
                kind: 2,
                language: 'sql',
                value: `
                    CREATE TABLE processed_inventory AS
                    SELECT id, product, category, quantity, price, (quantity * price) AS total_value
                    FROM local_inventory
                    ORDER BY id ASC;
                    SELECT * FROM processed_inventory;
                `,
                metadata: { label: 'process_sql', tableName: 'processed_inventory' }
            },
            // Cell 2: JSON Compose - Pull processed_inventory for Vega-Lite binding
            {
                kind: 2,
                language: 'json',
                value: JSON.stringify({
                    "$query": "SELECT product, total_value FROM processed_inventory",
                    "$as": "array"
                }),
                metadata: { label: 'json_compose', vuraType: 'json-compose' }
            },
            // Cell 3: Vega-Lite Graph - Render chart using JSON Compose output
            {
                kind: 2,
                language: 'vega-lite',
                value: JSON.stringify({
                    "description": "Total Value by Product",
                    "mark": "bar",
                    "encoding": {
                        "x": { "field": "product", "type": "nominal" },
                        "y": { "field": "total_value", "type": "quantitative" }
                    }
                }),
                metadata: {
                    label: 'vega_chart',
                    graphSourceCell: 2
                }
            },
            // Cell 4: HTML Nunjucks Template - Render dashboard report
            {
                kind: 2,
                language: 'html',
                value: `
                    <div class="report">
                        <h1>Inventory Report</h1>
                        <p>Total Items: {{ count }}</p>
                        <table>
                            {% for r in rows %}
                            <tr><td>{{ r.product }}</td><td>{{ r.total_value }}</td></tr>
                            {% endfor %}
                        </table>
                    </div>
                `,
                metadata: {
                    label: 'html_report',
                    templateContextTable: 'processed_inventory'
                }
            }
        ];

        const result = await runner.executeNotebook(cells, mockLogger);

        if (result.status !== 'success') {
            console.error('Notebook Execution Error Stack:', (result.error as any)?.stack || result.error);
        }
        expect(result.status).toBe('success');
        expect(result.error).toBeNull();

        // Verify DuckDB state
        const dbMgr = await DuckDbManager.getInstance(env);
        const rows = await dbMgr.runQuery('SELECT * FROM processed_inventory');
        expect(rows).toHaveLength(3);
        expect(rows[0].product).toBe('Laptop Stand');
        expect(rows[0].total_value).toBeCloseTo(449.85, 2);

        // Verify Vega-Lite cell output rendered HTML with embedded spec
        expect(cells[2].metadata?.vura_json_output).toBeDefined();
        expect(loggerOutput.html.some(h => h.includes('vegaEmbed') && h.includes('Laptop Stand'))).toBe(true);

        // Verify Nunjucks HTML report output
        expect(loggerOutput.html.some(h => h.includes('Inventory Report') && h.includes('Total Items: 3'))).toBe(true);
    });
});
