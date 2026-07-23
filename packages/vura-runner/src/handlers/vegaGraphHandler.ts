import * as fs from 'fs/promises';
import * as path from 'path';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';

// Cached Vega bundle scripts (read once from extension media assets)
let _vegaBundle: string | null = null;

async function loadVegaBundle(extensionPath: string): Promise<string | null> {
    if (_vegaBundle) { return _vegaBundle; }
    try {
        const dir = path.join(extensionPath, 'media', 'vega');
        const [vega, vegaLite, vegaEmbed] = await Promise.all([
            fs.readFile(path.join(dir, 'vega.min.js'), 'utf8'),
            fs.readFile(path.join(dir, 'vega-lite.min.js'), 'utf8'),
            fs.readFile(path.join(dir, 'vega-embed.min.js'), 'utf8'),
        ]);
        _vegaBundle = `${vega}\n${vegaLite}\n${vegaEmbed}`;
        return _vegaBundle;
    } catch (e: any) {
        // If the local bundle isn't available (e.g. running in CLI mode standalone), return null to use CDNs
        return null;
    }
}

import { handleJsonCompose } from './jsonComposeHandler';
import { DuckDbManager } from '../services/duckDbManager';

// ─── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Execute a Vega-Lite Graph cell.
 *
 * The user writes only the Vega-Lite spec (mark, encoding, transforms, etc).
 * Data is injected automatically from a source JSON Compose cell.
 *
 * Metadata used:
 *   - cell.metadata.graphSourceCell  → index of the JSON Compose cell to pull data from
 *   - cell.metadata.graphDataPath    → optional dot-path key into the JSON (e.g. "orders")
 */
export async function handleVegaGraph(
    cellSource: string,
    sourceCellIndex: number | undefined,
    dataPath: string | undefined,
    notebookCells: FlownbCell[],
    env: IVuraEnvironment,
    logger: ICellLogger,
    duckDb: DuckDbManager
): Promise<void> {
    const source = cellSource.trim();

    // 1. Parse the Vega-Lite spec
    let spec: any;
    try {
        spec = JSON.parse(source);
    } catch (err: any) {
        throw new Error(`Invalid Vega-Lite JSON: ${err.message}`);
    }

    // 2. If the spec already has a `data` property, render it as-is (standalone spec)
    let fullSpec: any;

    if (spec.data !== undefined) {
        // Standalone — use the spec unchanged
        fullSpec = {
            $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
            ...spec
        };
    } else {
        // Inject data from a linked JSON Compose cell
        if (sourceCellIndex === undefined || sourceCellIndex === null) {
            throw new Error(
                'No data source selected and spec has no inline `data`. ' +
                'Either add a "data" property to the spec, or link a JSON Compose cell.'
            );
        }

        if (sourceCellIndex < 0 || sourceCellIndex >= notebookCells.length) {
            throw new Error(`Source cell index ${sourceCellIndex} is out of range.`);
        }

        const sourceCell = notebookCells[sourceCellIndex];
        let jsonOutputStr = sourceCell.metadata?.vura_json_output;

        if (!jsonOutputStr) {
            if (sourceCell.language === 'json') {
                const dummyLogger: ICellLogger = {
                    logText: async () => {},
                    logError: async () => {},
                    logHtml: async () => {},
                    logJson: async () => {},
                    replaceOutput: async () => {},
                    logMultiple: async () => {},
                    clearOutput: async () => {}
                };
                jsonOutputStr = await handleJsonCompose(sourceCell.value, dummyLogger, duckDb);
            } else {
                throw new Error(
                    `Source cell ${sourceCellIndex + 1} has no JSON output and is not a JSON Compose cell.`
                );
            }
        }

        let jsonData: any;
        try {
            jsonData = JSON.parse(jsonOutputStr);
        } catch {
            throw new Error('Failed to parse source cell JSON output.');
        }

        // Navigate optional data path
        let chartData: any = jsonData;

        if (dataPath && dataPath.trim()) {
            const parts = dataPath.trim().split('.');
            for (const part of parts) {
                if (chartData && typeof chartData === 'object' && part in chartData) {
                    chartData = chartData[part];
                } else {
                    throw new Error(
                        `Data path "${dataPath}" not found in source JSON. Available keys: ${Object.keys(jsonData).join(', ')}`
                    );
                }
            }
        }

        if (!Array.isArray(chartData)) {
            chartData = (typeof chartData === 'object' && chartData !== null) ? [chartData] : [];
        }

        fullSpec = {
            $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
            ...spec,
            data: { values: chartData }
        };
    }

    // Default sizing for better notebook rendering
    if (!fullSpec.width) fullSpec.width = 'container';
    if (!fullSpec.height) fullSpec.height = 300;

    // 5. Render as HTML with inlined Vega scripts (avoids notebook CSP blocking CDN)
    const vegaBundle = await loadVegaBundle(env.extensionPath);
    const html = buildVegaHtml(fullSpec, vegaBundle);

    await logger.replaceOutput(html);
}



// ─── Vega-Lite HTML Builder ─────────────────────────────────────────────────────

function buildVegaHtml(spec: any, vegaBundle: string | null): string {
    const scripts = vegaBundle
        ? `<script>${vegaBundle}</script>`
        : `
<script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
        `;

    return `<!DOCTYPE html>
<html>
<head>
<style>
    body {
        margin: 0;
        padding: 8px;
        background: transparent;
        font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif);
    }
    #vis {
        width: 100%;
        height: 100%;
    }
    .vega-tooltip {
        font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif) !important;
        font-size: 12px !important;
        background: var(--vscode-editorWidget-background, #252526) !important;
        color: var(--vscode-foreground, #cccccc) !important;
        border: 1px solid var(--vscode-panel-border, #454545) !important;
        border-radius: 4px !important;
        padding: 6px 10px !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
    }
    .vega-tooltip td.key {
        color: var(--vscode-textLink-foreground, #3794ff) !important;
        font-weight: 600;
    }
    .vega-actions { display: none !important; }
</style>
${scripts}
</head>
<body>
<div id="vis"></div>
<script>
    vegaEmbed('#vis', ${JSON.stringify(spec)}, {
        renderer: 'svg',
        actions: false,
        theme: 'dark'
    }).catch(function(err) {
        document.getElementById('vis').innerHTML =
            '<pre style="color:#ff6b6b;padding:12px">Vega-Lite Error: ' + err.message + '</pre>';
    });
</script>
</body>
</html>`;
}
