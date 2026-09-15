import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveBrowserPath } from './browserPathHelper';

export async function handleGraphPdfExport(
    htmlContent: string,
    storagePath: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
        filters: { 'PDF Files': ['pdf'] },
        defaultUri: vscode.Uri.file('graph_export.pdf')
    });

    if (!uri) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting graph to PDF...`,
        cancellable: false
    }, async (progress) => {
        try {
            // Resolve browser path (auto-detect → prompt user → save to settings)
            const browserPath = await resolveBrowserPath();
            if (!browserPath) {
                vscode.window.showErrorMessage('PDF export cancelled — no browser executable was selected.');
                return;
            }

            progress.report({ message: 'Rendering PDF...' });

            let puppeteer: any;
            const extNodeModules = path.join(context.extensionPath, 'node_modules', 'puppeteer-core');
            const isolatedNodeModules = path.join(storagePath, 'node_modules', 'puppeteer-core');

            if (fs.existsSync(extNodeModules)) {
                puppeteer = require(extNodeModules);
            } else if (fs.existsSync(isolatedNodeModules)) {
                puppeteer = require(isolatedNodeModules);
            } else {
                puppeteer = require('puppeteer-core');
            }

            const cleanEnv = { ...process.env };
            delete cleanEnv.ELECTRON_RUN_AS_NODE;
            delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE;

            const browser = await puppeteer.launch({
                executablePath: browserPath,
                headless: 'new',
                env: cleanEnv,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });

            const page = await browser.newPage();
            await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });

            await page.pdf({
                path: uri.fsPath,
                format: 'A4',
                printBackground: true
            });

            await browser.close();
        } catch (err: any) {
            vscode.window.showErrorMessage(`PDF Export failed: ${err.message}`);
        }
    });
}
