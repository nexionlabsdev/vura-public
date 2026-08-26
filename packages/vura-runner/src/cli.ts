#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { CliEnvironment } from './cliEnvironment';
import { VuraRunner } from './runner';
import { FlownbCell, ICellLogger, SqlProfile } from './interfaces';
import { startServer } from './commands/serveCommand';
import { parseFlownbContent, parseFlownbDocument } from './utils/flownbLoader';
import { sidecarPool } from './services/sidecarPool';

class ConsoleLogger implements ICellLogger {
    private allOutputs: any[] = [];

    constructor(private rowLimit: number, private outputFile?: string) {}

    async logText(text: string): Promise<void> {
        console.log(text);
        this.allOutputs.push({ type: 'text', data: text });
    }

    async logError(error: string | Error): Promise<void> {
        console.error("ERROR:", error);
        this.allOutputs.push({ type: 'error', data: error.toString() });
    }

    async logHtml(html: string): Promise<void> {
        this.allOutputs.push({ type: 'html', data: html });
    }

    async logJson(json: any): Promise<void> {
        this.allOutputs.push({ type: 'json', data: json });
        if (Array.isArray(json)) {
            const limited = json.slice(0, this.rowLimit);
            if (limited.length > 0) {
                console.table(limited);
                if (json.length > this.rowLimit) {
                    console.log(`... and ${json.length - this.rowLimit} more rows. (Use --rows to see more)`);
                }
            } else {
                console.log("Empty result.");
            }
        } else {
            console.log(JSON.stringify(json, null, 2));
        }
    }

    async replaceOutput(html: string): Promise<void> {
        this.allOutputs.push({ type: 'html', data: html });
    }

    getAllHtml(): string {
        return this.allOutputs
            .filter(o => o.type === 'html')
            .map(o => o.data)
            .join('\n<hr>\n');
    }

    async logMultiple(items: { mime: string, data: any }[]): Promise<void> {
        for (const item of items) {
            if (item.mime === 'application/json') {
                await this.logJson(item.data);
            } else if (item.mime === 'application/vnd.vura.visual') {
                await this.logHtml(item.data);
            } else {
                console.log(`[${item.mime} Output omitted]`);
            }
        }
    }
    
    async clearOutput(): Promise<void> { }

    async saveOutput(): Promise<void> {
        if (this.outputFile) {
            await fs.writeFile(this.outputFile, JSON.stringify(this.allOutputs, null, 2), 'utf8');
            console.log(`Saved execution output to ${this.outputFile}`);
        }
    }
}

const program = new Command();
program
    .name('vura-runner')
    .description('CLI to execute VURA .flownb notebooks')
    .version('1.0.0');

import { compileTarget } from './commands/compileCommand';

program.command('compile [target]')
    .description('Compile .flownb notebook(s), check diagnostics, provision dependencies, and generate .vura/manifest.json')
    .option('--env <path>', 'Path to .env file')
    .action(async (targetArg, options) => {
        try {
            const target = targetArg || '.';
            await compileTarget(target, options.env);
        } catch (e: any) {
            console.error('Compilation failed:', e.message || e);
            process.exit(1);
        }
    });

program.command('serve [target]')
    .description('Start an HTTP server to trigger .flownb files via API')
    .option('--port <number>', 'Port to run the server on', '3000')
    .option('--notebooks-dir <path>', 'Directory containing .flownb files')
    .option('--env <path>', 'Path to .env file')
    .option('--max-log-size <number>', 'Max log/output size in MB per cell before truncation', '5')
    .action(async (targetArg, options) => {
        const target = options.notebooksDir || targetArg || '.';
        await startServer(parseInt(options.port, 10), target, options.env, parseInt(options.maxLogSize, 10));
    });

async function parseHttpRequestContext(options: any): Promise<any | null> {
    const hasHttpInput = options.request || options.data || options.header || options.query || options.param || options.get;
    if (!hasHttpInput) return null;

    const method = (options.request || (options.data && !options.get ? 'POST' : 'GET')).toUpperCase();

    // Headers parsing
    const headers: Record<string, string> = {};
    if (options.header) {
        const rawHeaders = Array.isArray(options.header) ? options.header : [options.header];
        for (const h of rawHeaders) {
            const idx = h.indexOf(':');
            if (idx > 0) {
                const key = h.substring(0, idx).trim().toLowerCase();
                const val = h.substring(idx + 1).trim();
                headers[key] = val;
            }
        }
    }

    // Query parsing
    const query: Record<string, any> = {};
    const parseQueryStr = (qs: string) => {
        const clean = qs.startsWith('?') ? qs.substring(1) : qs;
        const parts = clean.split('&');
        for (const part of parts) {
            if (!part) continue;
            const [k, v] = part.split('=');
            if (k) {
                query[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
            }
        }
    };

    if (options.query) {
        if (typeof options.query === 'string' && options.query.trim().startsWith('{')) {
            try {
                Object.assign(query, JSON.parse(options.query));
            } catch {
                parseQueryStr(options.query);
            }
        } else {
            parseQueryStr(String(options.query));
        }
    }

    if (options.param) {
        const params = Array.isArray(options.param) ? options.param : [options.param];
        for (const p of params) {
            const idx = p.indexOf('=');
            if (idx > 0) {
                const key = p.substring(0, idx).trim();
                const val = p.substring(idx + 1).trim();
                query[key] = val;
            }
        }
    }

    // Body parsing
    let body: any = {};
    if (options.data) {
        let rawData = options.data;
        if (typeof rawData === 'string' && rawData.startsWith('@')) {
            const filePath = path.resolve(process.cwd(), rawData.substring(1));
            rawData = await fs.readFile(filePath, 'utf8');
        }

        if (options.get) {
            parseQueryStr(String(rawData));
        } else {
            try {
                body = JSON.parse(rawData);
            } catch {
                if (headers['content-type']?.includes('application/x-www-form-urlencoded') || String(rawData).includes('=')) {
                    const parsed: Record<string, any> = {};
                    const clean = String(rawData).startsWith('?') ? String(rawData).substring(1) : String(rawData);
                    for (const part of clean.split('&')) {
                        if (!part) continue;
                        const [k, v] = part.split('=');
                        if (k) parsed[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
                    }
                    body = parsed;
                } else {
                    body = rawData;
                }
            }
        }
    }

    return { query, body, headers, method };
}

program.command('execute')
    .description('Execute a .flownb file')
    .argument('<file>', 'path to .flownb file')
    .option('-X, --request <method>', 'HTTP request method (GET, POST, PUT, DELETE, etc.)')
    .option('-d, --data <data>', 'HTTP request body data (raw JSON string or @file)')
    .option('-H, --header <header...>', 'HTTP request header (e.g. -H "Content-Type: application/json")')
    .option('-q, --query <query>', 'HTTP query string or JSON (e.g. -q "page=2&page_size=10")')
    .option('-p, --param <key=value...>', 'HTTP query parameter pair (e.g. -p page=2 -p page_size=10)')
    .option('-G, --get', 'Send -d/--data as query parameters (curl compatible)')
    .option('--session <id>', 'Session identifier for isolated execution storage')
    .option('--env <path>', 'Path to .env file')
    .option('--rows <number>', 'Number of rows to display for tabular output', '5')
    .option('--output <path>', 'File path to save JSON output')
    .option('--cell <index>', 'Execute only a specific cell (1-based index)')
    .option('--export-html <path>', 'Export visual cells to an HTML file')
    .option('--export-png <path>', 'Export visual cells to a PNG image using headless Chrome')
    .option('--export-pdf <path>', 'Export visual cells to a PDF document using headless Chrome')
    .option('--open', 'Open the exported HTML or visual output in the default browser')
    .option('--dry-run', 'Print execution plan showing which cells would be skipped based on runWhen')
    .action(async (file, options) => {
        try {
            const fullPath = path.resolve(process.cwd(), file);
            const content = await fs.readFile(fullPath, 'utf8');
            const doc = parseFlownbDocument(content);
            const cells = doc.cells;

            if (options.dryRun) {
                const { ConditionEvaluator } = require('./services/conditionEvaluator');
                const evaluator = new ConditionEvaluator();
                console.log(`\nDry run execution plan for ${file}:`);
                console.table(cells.map((cell, i) => {
                    const runWhen = cell.metadata?.runWhen as string | undefined;
                    const wouldRun = cell.kind === 2 ? evaluator.evaluate(runWhen, { cells: {}, groups: {}, env: {} }) : false;
                    return {
                        Index: i + 1,
                        Kind: cell.kind === 2 ? 'Code' : 'Markdown',
                        Language: cell.language || 'N/A',
                        Label: cell.metadata?.label || '-',
                        Group: cell.metadata?.group || '-',
                        RunWhen: runWhen || '-',
                        WouldRun: wouldRun
                    };
                }));
                process.exit(0);
            }

            const sessionScope = options.session || path.basename(fullPath);
            const env = new CliEnvironment(path.dirname(fullPath), options.env, sessionScope);
            const runner = new VuraRunner(env);
            const logger = new ConsoleLogger(parseInt(options.rows, 10), options.output);

            const httpContext = await parseHttpRequestContext(options);
            if (httpContext) {
                await runner.injectHttpRequest(httpContext, logger);
            }

            if (options.cell) {
                const targetIndex = parseInt(options.cell, 10) - 1;
                if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= cells.length) {
                    console.error(`Invalid cell index: ${options.cell}. Notebook has ${cells.length} cells.`);
                    process.exit(1);
                }

                console.log(`Executing cell ${targetIndex + 1} of ${cells.length} in ${file}...`);
                console.log(`\n--- Executing Cell ${targetIndex + 1} (${cells[targetIndex].language || 'markdown'}) ---`);

                // Load required plugins if specified
                const { loadPlugins } = require('./pluginLoader');
                const rawConfiguredPlugins = env.getConfig<string[] | string>('vura.plugins', []);
                let configuredPlugins: string[] = [];
                if (Array.isArray(rawConfiguredPlugins)) {
                    configuredPlugins = rawConfiguredPlugins;
                } else if (typeof rawConfiguredPlugins === 'string' && rawConfiguredPlugins.trim()) {
                    try {
                        const parsed = JSON.parse(rawConfiguredPlugins);
                        configuredPlugins = Array.isArray(parsed) ? parsed : [rawConfiguredPlugins];
                    } catch {
                        configuredPlugins = [rawConfiguredPlugins];
                    }
                }
                const pluginNames = Array.from(new Set([...(doc.requiredPlugins ?? []), ...configuredPlugins]));
                if (pluginNames.length > 0) {
                    await loadPlugins(pluginNames, env, logger);
                }

                if (cells[targetIndex].kind === 2) {
                    await runner.executeCell(cells[targetIndex], targetIndex, cells, logger);
                } else {
                    console.log(`Cell ${targetIndex + 1} is a markdown cell. Skipping.`);
                }
            } else {
                console.log(`Executing ${cells.length} cells in ${file}...`);

                const result = await runner.executeNotebook(cells, logger, process.env as any, {
                    onCellStart: (index) => console.log(`\n--- Executing Cell ${index + 1} (${cells[index].language}) ---`)
                }, doc.requiredPlugins);

                if (result.status === 'error') {
                    console.error(`\nNotebook execution completed with errors: ${result.error}`);
                }
            }

            await logger.saveOutput();

            const combinedHtml = logger.getAllHtml();
            if (combinedHtml && (options.exportHtml || options.exportPng || options.exportPdf || options.open)) {
                let htmlPath = options.exportHtml;
                if (!htmlPath) {
                    htmlPath = path.join(env.storagePath, 'temp_output.html');
                } else {
                    htmlPath = path.resolve(process.cwd(), htmlPath);
                }

                await fs.writeFile(htmlPath, combinedHtml, 'utf8');
                if (options.exportHtml) {
                    console.log(`Exported HTML to ${htmlPath}`);
                }

                if (options.exportPng) {
                    const pngPath = path.resolve(process.cwd(), options.exportPng);
                    try {
                        const puppeteer = require('puppeteer-core');
                        const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
                        const page = await browser.newPage();
                        await page.setContent(combinedHtml, { waitUntil: 'networkidle0' });
                        await page.screenshot({ path: pngPath, fullPage: true });
                        await browser.close();
                        console.log(`Exported PNG to ${pngPath}`);
                        const duckDb = await (runner as any)._getDuckDb();
                        const targetCellIndex = options.cell ? parseInt(options.cell, 10) - 1 : 0;
                        await duckDb.registerVisualOutputTable(targetCellIndex, 'png', pngPath, env.storagePath);
                    } catch (err: any) {
                        console.error('Failed to export PNG. Is Chrome/Edge installed?', err.message);
                    }
                }

                if (options.exportPdf) {
                    const pdfPath = path.resolve(process.cwd(), options.exportPdf);
                    try {
                        const puppeteer = require('puppeteer-core');
                        const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
                        const page = await browser.newPage();
                        await page.setContent(combinedHtml, { waitUntil: 'networkidle0' });
                        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
                        await browser.close();
                        console.log(`Exported PDF to ${pdfPath}`);
                        const duckDb = await (runner as any)._getDuckDb();
                        const targetCellIndex = options.cell ? parseInt(options.cell, 10) - 1 : 0;
                        await duckDb.registerVisualOutputTable(targetCellIndex, 'pdf', pdfPath, env.storagePath);
                    } catch (err: any) {
                        console.error('Failed to export PDF. Is Chrome/Edge installed?', err.message);
                    }
                }

                if (options.open) {
                    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
                    exec(`${openCmd} "${htmlPath}"`);
                    console.log(`Opened visual output in browser.`);
                }
            }

            console.log('\nExecution complete.');
            await sidecarPool.disposeAll();
            process.exit(0);
        } catch (e: any) {
            console.error('\nExecution failed:', e.message || e);
            await sidecarPool.disposeAll();
            process.exit(1);
        }
    });

program.command('list')
    .description('List cells in a .flownb file')
    .argument('<file>', 'path to .flownb file')
    .action(async (file) => {
        try {
            const fullPath = path.resolve(process.cwd(), file);
            const content = await fs.readFile(fullPath, 'utf8');
            const cells = parseFlownbContent(content);
            
            console.log(`Cells in ${file}:`);
            cells.forEach((c, index) => {
                const kind = c.kind === 2 ? 'Code' : 'Markdown';
                const lang = c.language || 'N/A';
                const snippet = c.value ? c.value.substring(0, 50).replace(/\n/g, ' ') : '';
                console.log(`[${index + 1}] ${kind} (${lang}): ${snippet}...`);
            });
        } catch (e: any) {
            console.error('Failed to list cells:', e.message || e);
            process.exit(1);
        }
    });

const KNOWN_CONFIG_KEYS = `
Known keys:
  vura.plugins               string[]  Add-on plugin package names to load at startup
                                        (also settable per-notebook via requiredPlugins).
                                        Default: []
  vura.python.venvPath       string    Path to the Python venv used by python cells
                                        and !pip/!python terminal commands.
                                        Default: <storagePath>/venv
  vura.depthLimit             number   Max recursion depth for the Auto-Schema
                                        Flattener (nested JSON -> Parquet tables).
                                        Default: 5
  vura.odataBatchSize         number   Batch size for Dataverse OData $batch writeback
                                        (-- !odata-push SQL magic comment).
                                        Default: 500

Values are parsed as JSON where possible, so booleans/numbers/arrays round-trip
correctly (e.g. \`config set vura.depthLimit 8\` stores an actual number, not
the string "8"). Plain strings that aren't valid JSON (like a filesystem path)
are stored as-is.

Stored in ~/.vura/config.json.`;

const configCmd = program.command('config')
    .description('Manage global VURA configuration (~/.vura/config.json)')
    .addHelpText('after', KNOWN_CONFIG_KEYS);

configCmd.command('set')
    .description('Set a global configuration value')
    .argument('<key>', 'Configuration key, e.g. vura.plugins')
    .argument('<value>', 'Configuration value (parsed as JSON where possible)')
    .addHelpText('after', KNOWN_CONFIG_KEYS)
    .action(async (key, value) => {
        const env = new CliEnvironment(process.cwd());
        await env.setConfigValue(key, value);
        const stored = await env.getConfigValue(key);
        console.log(`Successfully set ${key} = ${JSON.stringify(stored)}`);
    });

configCmd.command('get')
    .description('Print the current value of a configuration key')
    .argument('<key>', 'Configuration key, e.g. vura.plugins')
    .action(async (key) => {
        const env = new CliEnvironment(process.cwd());
        const value = await env.getConfigValue(key);
        if (value === undefined) {
            console.log(`${key} is not set.`);
        } else {
            console.log(JSON.stringify(value, null, 2));
        }
    });

configCmd.command('list')
    .description('List all configuration values currently set')
    .action(async () => {
        const env = new CliEnvironment(process.cwd());
        const values = await env.listConfigValues();
        if (Object.keys(values).length === 0) {
            console.log('No configuration values set.');
        } else {
            console.log(JSON.stringify(values, null, 2));
        }
    });

configCmd.command('unset')
    .description('Remove a configuration key, reverting it to its default')
    .argument('<key>', 'Configuration key, e.g. vura.plugins')
    .action(async (key) => {
        const env = new CliEnvironment(process.cwd());
        const existed = await env.unsetConfigValue(key);
        console.log(existed ? `Removed ${key}.` : `${key} was not set.`);
    });

const credentialsCmd = program.command('credentials').description('Manage stored SQL credentials');

credentialsCmd.command('list')
    .description('List stored connection profiles')
    .action(async () => {
        const env = new CliEnvironment(process.cwd());
        const store = await env.loadCredentialsStore();
        const profiles = Object.keys(store);
        if (profiles.length === 0) {
            console.log("No stored credentials found.");
        } else {
            console.log("Stored connection profiles:");
            profiles.forEach(id => {
                const p = store[id].profile;
                console.log(` - ${id} (${p.server}:${p.database}) [${p.authMode}]`);
            });
        }
    });

credentialsCmd.command('add')
    .description('Add a new connection profile')
    .argument('<id>', 'Profile ID')
    .argument('<server>', 'Server address')
    .argument('<database>', 'Database name')
    .argument('<authMode>', 'Auth Mode (ServicePrincipal|DeviceCode|SqlLogin|WindowsAuth)')
    .option('--client-id <id>', 'Client ID')
    .option('--tenant-id <id>', 'Tenant ID')
    .option('--username <user>', 'Username')
    .option('--secret <secret>', 'Secret payload (JSON format, e.g. {"token":"..."} or plain password)')
    .action(async (id, server, database, authMode, options) => {
        const env = new CliEnvironment(process.cwd());
        const store = await env.loadCredentialsStore();

        const profile: SqlProfile = {
            id, name: id, server, database, port: 1433, authMode: authMode as any,
            clientId: options.clientId,
            tenantId: options.tenantId,
            username: options.username
        };

        store[id] = { profile, secret: options.secret || '' };
        await env.saveCredentialsStore(store);
        console.log(`Profile ${id} added successfully.`);
    });

credentialsCmd.command('remove')
    .description('Remove a connection profile')
    .argument('<id>', 'Profile ID')
    .action(async (id) => {
        const env = new CliEnvironment(process.cwd());
        const store = await env.loadCredentialsStore();
        if (store[id]) {
            delete store[id];
            await env.saveCredentialsStore(store);
            console.log(`Profile ${id} removed.`);
        } else {
            console.log(`Profile ${id} not found.`);
        }
    });

credentialsCmd.command('update')
    .description('Update an existing connection profile')
    .argument('<id>', 'Profile ID')
    .option('--server <server>', 'Server address')
    .option('--database <db>', 'Database name')
    .option('--authMode <mode>', 'Auth Mode (ServicePrincipal|DeviceCode|SqlLogin|WindowsAuth)')
    .option('--client-id <id>', 'Client ID')
    .option('--tenant-id <id>', 'Tenant ID')
    .option('--username <user>', 'Username')
    .option('--secret <secret>', 'Secret payload (JSON format or plain password)')
    .action(async (id, options) => {
        const env = new CliEnvironment(process.cwd());
        const store = await env.loadCredentialsStore();
        if (!store[id]) {
            console.log(`Profile ${id} not found. Use 'add' to create it.`);
            return;
        }

        const current = store[id].profile;
        store[id].profile = {
            ...current,
            server: options.server || current.server,
            database: options.database || current.database,
            authMode: options.authMode || current.authMode,
            clientId: options.clientId !== undefined ? options.clientId : current.clientId,
            tenantId: options.tenantId !== undefined ? options.tenantId : current.tenantId,
            username: options.username !== undefined ? options.username : current.username
        };
        
        if (options.secret !== undefined) {
            store[id].secret = options.secret;
        }

        await env.saveCredentialsStore(store);
        console.log(`Profile ${id} updated successfully.`);
    });

program.parse(process.argv);
