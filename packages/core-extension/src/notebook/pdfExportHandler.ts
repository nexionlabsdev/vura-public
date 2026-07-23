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

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting graph to PDF...`,
        cancellable: false
    }, async (progress) => {
        try {
            // Check for puppeteer-core in the isolated environment
            const isolatedNodeModules = path.join(storagePath, 'node_modules', 'puppeteer-core');
            if (!fs.existsSync(isolatedNodeModules)) {
                progress.report({ message: 'Installing puppeteer-core (first time only)...' });
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                spawnSync(npmCmd, ['install', 'puppeteer-core'], { cwd: storagePath });
            }

            // Resolve browser path (auto-detect → prompt user → save to settings)
            const browserPath = await resolveBrowserPath();
            if (!browserPath) {
                vscode.window.showErrorMessage('PDF export cancelled — no browser executable was selected.');
                return;
            }

            progress.report({ message: 'Rendering PDF...' });

            // Require puppeteer-core from the isolated environment
            const puppeteer = require(path.join(storagePath, 'node_modules', 'puppeteer-core'));

            const browser = await puppeteer.launch({
                executablePath: browserPath,
                headless: "new"
            });

            const page = await browser.newPage();

            // Wait for network idle to ensure vega-lite finishes rendering
            await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

            await page.pdf({
                path: uri.fsPath,
                format: 'A4',
                printBackground: true
            });

            await browser.close();

            const action = await vscode.window.showInformationMessage(`PDF Export successful: ${uri.fsPath}`, 'Open PDF');
            if (action === 'Open PDF') {
                vscode.env.openExternal(uri);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`PDF Export failed: ${err.message}`);
        }
    });
}
