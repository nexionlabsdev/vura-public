import * as nunjucks from 'nunjucks';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { IVuraEnvironment, ICellLogger } from '../interfaces';

/**
 * Custom Nunjucks filter: extract keys from an object.
 * Usage inside template: `{% for key in row | keys %}`
 */
const nunjucksEnv = new nunjucks.Environment(null, { autoescape: false });
nunjucksEnv.addFilter('keys', (obj: any) => {
    if (obj && typeof obj === 'object') {
        return Object.keys(obj);
    }
    return [];
});

/**
 * Execute an HTML template cell using Nunjucks.
 *
 * The cell's metadata `templateContextTable` identifies the DuckDB table
 * whose rows are injected as template context.
 *
 * Template context shape:
 *   { rows: any[], row: any (first row), count: number }
 */
export async function handleTemplateExecution(
    templateSource: string,
    contextTable: string | undefined,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {

    let rows: any[] = [];

    if (contextTable) {
        // Lazy-require to mirror existing patterns in the codebase
        const { DuckDbManager } = require('../services/duckDbManager');
        const duckDb = await DuckDbManager.getInstance(env);

        try {
            rows = await duckDb.runQuery(`SELECT * FROM "${contextTable}"`);
        } catch (err: any) {
            throw new Error(`Template context table "${contextTable}" not found in DuckDB. Run the source cell first.`);
        }
    }

    const templateContext = {
        rows,
        row: rows.length > 0 ? rows[0] : {},
        count: rows.length
    };

    // Render
    let renderedHtml: string;
    try {
        renderedHtml = nunjucksEnv.renderString(templateSource, templateContext);
    } catch (err: any) {
        throw new Error(`Nunjucks render error: ${err.message}`);
    }

    // Output rendered HTML inline
    await logger.replaceOutput(renderedHtml);
}

/**
 * Export the rendered HTML output of a template cell to a PDF file.
 * Uses puppeteer-core with a local Chrome/Edge instance.
 */
export async function handleTemplatePdfExport(
    htmlContent: string,
    storagePath: string,
    pdfOutputPath: string,
    browserPath: string
): Promise<void> {
    try {
        // Ensure puppeteer-core is installed in the isolated environment
        const isolatedPuppeteer = path.join(storagePath, 'node_modules', 'puppeteer-core');
        if (!fs.existsSync(isolatedPuppeteer)) {
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            spawnSync(npmCmd, ['install', 'puppeteer-core'], { cwd: storagePath });
        }

        const puppeteer = require(path.join(storagePath, 'node_modules', 'puppeteer-core'));

        const browser = await puppeteer.launch({
            executablePath: browserPath,
            headless: 'new'
        });

        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        await page.pdf({
            path: pdfOutputPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
        });

        await browser.close();
    } catch (err: any) {
        throw new Error(`PDF Export failed: ${err.message}`);
    }
}
