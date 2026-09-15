import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Shared utility to resolve a Chrome/Edge browser executable path.
 * Priority: user setting → OS defaults → prompt user to pick → undefined.
 * If the user picks a path, it is persisted to the `vura.browserPath` setting.
 */
export async function resolveBrowserPath(): Promise<string | undefined> {
    // 1. Check user setting first
    const config = vscode.workspace.getConfiguration('vura');
    let browserPath = config.get<string>('browserPath');

    if (browserPath && fs.existsSync(browserPath)) {
        return browserPath;
    }

    // 2. Probe OS-default install locations
    browserPath = getOSBrowserPath();
    if (browserPath) {
        return browserPath;
    }

    // 3. Prompt the user to locate the browser executable
    const selection = await vscode.window.showWarningMessage(
        'Chrome or Edge was not found in the default locations. Please select the browser executable to use for PDF rendering.',
        'Browse…',
        'Cancel'
    );

    if (selection !== 'Browse…') {
        return undefined;
    }

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select Chrome / Edge Executable',
        filters: process.platform === 'win32'
            ? { 'Executables': ['exe'] }
            : undefined
    });

    if (!uris || uris.length === 0) {
        return undefined;
    }

    const selectedPath = uris[0].fsPath;

    // Persist to user settings so they are never prompted again
    await config.update('browserPath', selectedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Browser path saved: ${selectedPath}`);

    return selectedPath;
}

function getOSBrowserPath(): string | undefined {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if (isWindows) {
        const paths = [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ];
        return paths.find(p => fs.existsSync(p));
    } else if (isMac) {
        const paths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
        return paths.find(p => fs.existsSync(p));
    } else if (isLinux) {
        const paths = [
            '/usr/bin/google-chrome',
            '/usr/bin/microsoft-edge'
        ];
        return paths.find(p => fs.existsSync(p));
    }
    return undefined;
}
