import * as vscode from 'vscode';
import * as path from 'path';
import { ProviderRegistry } from '@vura-data-os/core-sdk';
import { sidecarPool, DuckDbManager, getVenvPythonBin, discoverWorkspaceVenvs } from '@vura-data-os/vura-runner';
import { ConnectionManager } from '../connectionManager';
import { VsCodeEnvironment } from '../VsCodeEnvironment';
import {
    getConnectorKindDescriptors,
    testConnectorConfig
} from '../connectionsConfigViewProvider';
import { getHubHtml } from './hubHtml';
import {
    getRuntimeStatus,
    installPythonPackage,
    uninstallPythonPackage,
    isPythonPackageInstalled,
    createVenv
} from './runtimeStatus';
import { getAddonStatuses, PYTHON_PACKAGE_CATALOG } from './addonsCatalog';
import { getStorageStatus, purgeDirectoryContents, CACHE_DIRECTORY_CONFIG_KEY } from './storageStatus';

/**
 * Full-tab "VURA Environment Hub" — the developer-platform control plane
 * (Runtime Readiness, Connectors, Add-ons, Storage), opened in ViewColumn.One
 * via the `vura.openEnvironmentHub` command. Singleton: re-invoking the
 * command reveals the existing tab instead of opening a second one.
 */
export class HubPanel {
    public static readonly viewType = 'vura.environmentHub';
    private static current: HubPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext) {
        if (HubPanel.current) {
            HubPanel.current.panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            HubPanel.viewType,
            'VURA Environment Hub',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        HubPanel.current = new HubPanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext) {
        this.panel = panel;
        this.outputChannel = vscode.window.createOutputChannel('VURA Environment Hub');
        this.panel.webview.html = getHubHtml();

        this.panel.webview.onDidReceiveMessage(async data => {
            try {
                await this.handleMessage(data);
            } catch (err: any) {
                vscode.window.showErrorMessage(`VURA Hub: ${err?.message || err}`);
            }
        }, null, this.disposables);

        // Keep the Add-ons Marketplace tab (and everything else that reads
        // vscode.extensions.getExtension) in sync with installs/uninstalls
        // done from the native Extensions view while this panel is open —
        // previously it only reflected extension state from the moment the
        // panel was created/last refreshed, so an install elsewhere looked
        // like it hadn't taken effect until the panel was closed and reopened.
        vscode.extensions.onDidChange(() => {
            this.pushState('refresh').catch(err =>
                vscode.window.showErrorMessage(`VURA Hub: ${err?.message || err}`)
            );
        }, null, this.disposables);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async handleMessage(data: any) {
        switch (data.type) {
            case 'requestData':
                await this.pushState('init');
                break;
            case 'autoDetectVenv': {
                // Previously piggybacked on the generic 'requestData' refresh,
                // whose result only fed an internal pythonBin used for status
                // checks — venvPathInput only ever reflects configuredVenvPath
                // (see renderRuntime() in hubHtml.ts), so a found candidate was
                // never actually applied and the button looked like a no-op.
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage('Open a workspace folder before auto-detecting a virtual environment.');
                    break;
                }
                const candidates = await discoverWorkspaceVenvs(workspaceRoot);
                const found = candidates.find(c => c.pythonBin);
                if (!found) {
                    vscode.window.showWarningMessage(
                        'No virtual environment found in this workspace or its immediate subfolders. Use "Browse..." or "Create venv here" instead.'
                    );
                    break;
                }
                const env = new VsCodeEnvironment(this.context);
                await env.setPythonVenvPath(found.folder);
                vscode.window.showInformationMessage(`Auto-detected venv: ${path.relative(workspaceRoot, found.folder) || found.folder}`);
                await this.pushState('refresh');
                break;
            }
            case 'browseVenvPath': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Virtual Environment Folder',
                    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                    title: 'Select venv folder — hidden folders like .venv may need "Show Hidden Files" enabled in this dialog (macOS: Cmd+Shift+.)'
                });
                if (!picked || picked.length === 0) break;
                const selected = picked[0].fsPath;

                const { promises: fsp } = require('fs');
                let finalPath = selected;
                try {
                    await fsp.access(getVenvPythonBin(selected));
                } catch {
                    // The picked folder isn't a venv itself — but the user
                    // may have picked a project folder (e.g. "samples")
                    // whose venv actually lives one level down at
                    // "samples/.venv". discoverWorkspaceVenvs checks both
                    // the folder itself and its immediate subdirectories.
                    const nested = (await discoverWorkspaceVenvs(selected)).find(c => c.pythonBin);
                    if (nested) {
                        const nestedLabel = `Use "${path.relative(selected, nested.folder)}"`;
                        const anywayLabel = `Use "${path.basename(selected)}" anyway`;
                        const choice = await vscode.window.showInformationMessage(
                            `"${path.basename(selected)}" isn't a venv itself, but contains one at "${path.relative(selected, nested.folder)}".`,
                            { modal: true },
                            nestedLabel, anywayLabel
                        );
                        if (!choice) break;
                        finalPath = choice === nestedLabel ? nested.folder : selected;
                    } else {
                        const anyway = await vscode.window.showWarningMessage(
                            `"${path.basename(selected)}" doesn't look like a valid venv (no python binary found in it or its immediate subfolders). Use it anyway?`,
                            { modal: true },
                            'Use Anyway'
                        );
                        if (anyway !== 'Use Anyway') break;
                    }
                }

                const env = new VsCodeEnvironment(this.context);
                await env.setPythonVenvPath(finalPath);
                await this.pushState('refresh');
                break;
            }
            case 'createVenv': {
                const defaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!defaultRoot) {
                    vscode.window.showErrorMessage('Open a workspace folder before creating a virtual environment.');
                    break;
                }
                // Previously hardcoded to <workspace root>/.venv regardless of
                // anything the user had browsed to — "Create venv here" created
                // "here" meaning always the top-level workspace root, silently
                // overwriting whatever interpreter path was already configured.
                // Ask where, same as the notebook toolbar's venv picker.
                const parentUris = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    defaultUri: defaultRoot,
                    openLabel: 'Choose where to create the venv',
                    title: 'Choose where to create the venv'
                });
                if (!parentUris || parentUris.length === 0) break;

                const venvName = await vscode.window.showInputBox({
                    prompt: 'Name for the new virtual environment folder',
                    value: '.venv',
                    validateInput: v => v.trim() ? undefined : 'Name cannot be empty'
                });
                if (!venvName) break;

                const folder = path.join(parentUris[0].fsPath, venvName);

                const confirm = await vscode.window.showWarningMessage(
                    `Create venv at: ${folder}?`,
                    { modal: true },
                    'Create'
                );
                if (confirm !== 'Create') break;

                const env = new VsCodeEnvironment(this.context);
                this.outputChannel.show(true);
                await createVenv(folder, this.outputChannel);
                await env.setPythonVenvPath(folder);
                vscode.window.showInformationMessage(`Created virtual environment at ${folder}`);
                await this.pushState('refresh');
                break;
            }
            case 'installBridge': {
                const status = await getRuntimeStatus(this.context);
                if (!status.pythonBin) {
                    vscode.window.showErrorMessage('No Python interpreter resolved yet.');
                    break;
                }
                this.outputChannel.show(true);
                await installPythonPackage(status.pythonBin, status.bridgePackageName, this.outputChannel);
                vscode.window.showInformationMessage(`${status.bridgePackageName} installed.`);
                await this.pushState('refresh');
                break;
            }
            case 'installPythonPackage': {
                const status = await getRuntimeStatus(this.context);
                if (!status.pythonBin) break;
                this.outputChannel.show(true);
                await installPythonPackage(status.pythonBin, data.name, this.outputChannel);
                await this.pushState('refresh');
                break;
            }
            case 'uninstallPythonPackage': {
                const status = await getRuntimeStatus(this.context);
                if (!status.pythonBin) break;
                this.outputChannel.show(true);
                await uninstallPythonPackage(status.pythonBin, data.name, this.outputChannel);
                await this.pushState('refresh');
                break;
            }
            case 'terminateSession': {
                const confirm = await vscode.window.showWarningMessage(
                    `Terminate the sidecar/DuckDB session for notebook "${data.notebookId}"? Any in-flight cell execution will fail.`,
                    { modal: true }, 'Terminate'
                );
                if (confirm !== 'Terminate') break;
                await sidecarPool.terminateSession(data.notebookId);
                DuckDbManager.disposeNotebook(data.notebookId);
                await this.pushState('refresh');
                break;
            }
            case 'viewLogs':
                this.outputChannel.show(true);
                break;
            case 'saveConnection':
                await this.saveConnection(data);
                await this.pushState('refresh');
                break;
            case 'deleteConnection':
                await ConnectionManager.removeAnyConnectionProfile(this.context, data.id);
                await this.pushState('refresh');
                break;
            case 'testConnection': {
                // A blank secret on an existing (non-new) profile means "unchanged" in the
                // form, not "no secret" — without this, testing an already-saved connection
                // would always fail auth since the webview never re-populates secret fields.
                let secret = data.secret;
                if (!secret && !data.isNewProfile && data.id) {
                    secret = await ConnectionManager.getSecretForConnectionProfile(this.context, data.id);
                }
                const result = await testConnectorConfig(data.kind, data.config, secret);
                this.panel.webview.postMessage({ type: 'connTestResult', ...result });
                break;
            }
            case 'setMirrorEnabled':
                await ConnectionManager.setWorkspaceMirrorEnabled(this.context, !!data.enabled);
                await this.pushState('refresh');
                break;
            case 'setActiveProfile':
                // Only 'sql' profiles have an "active" concept — Schema Explorer, SQL
                // IntelliSense, and the status bar all read ConnectionManager's single active
                // SqlProfile, independent of whatever's selected/being-edited in this panel.
                await ConnectionManager.setActiveProfile(this.context, data.id);
                vscode.window.showInformationMessage('Active connection updated — Schema Explorer will refresh.');
                await this.pushState('refresh');
                break;
            case 'toggleAddonEnabled':
                if (data.providerId) {
                    ProviderRegistry.getInstance().setProviderEnabled(data.providerId, !!data.enabled);
                    await this.context.globalState.update(`vura-addon-enabled-${data.providerId}`, !!data.enabled);
                }
                await this.pushState('refresh');
                break;
            case 'installProviderExtension':
                await vscode.commands.executeCommand('workbench.extensions.search', `@id:${data.extensionId}`);
                break;
            case 'browseConnectionField': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Folder',
                    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
                });
                this.panel.webview.postMessage({
                    type: 'browseConnectionFieldResult',
                    key: data.key,
                    path: picked && picked.length > 0 ? picked[0].fsPath : undefined
                });
                break;
            }
            case 'purgeTempFiles': {
                const env = new VsCodeEnvironment(this.context);
                const storage = await getStorageStatus(env.storagePath);
                const confirm = await vscode.window.showWarningMessage(
                    `Delete all temp/scratch files in ${storage.directory}? This cannot be undone.`,
                    { modal: true }, 'Purge'
                );
                if (confirm !== 'Purge') break;
                const result = await purgeDirectoryContents(storage.directory);
                vscode.window.showInformationMessage(`Purged ${result.deletedCount} item(s)${result.skippedCount ? `, ${result.skippedCount} skipped (in use)` : ''}.`);
                await this.pushState('refresh');
                break;
            }
        }
    }

    private async saveConnection(data: { id: string; name: string; kind: string; config: Record<string, any>; secret?: string }) {
        const { id, name, kind, config, secret } = data;
        if (kind === 'sql') {
            await ConnectionManager.saveProfile(this.context, {
                id, name,
                authMode: config.authMode,
                server: config.server,
                database: config.database,
                port: config.port ? parseInt(config.port, 10) : 1433,
                clientId: config.clientId || undefined,
                tenantId: config.tenantId || undefined,
                username: config.username || undefined,
                domain: config.domain || undefined
            } as any, secret);
        } else {
            await ConnectionManager.saveConnectionProfile(this.context, { id, name, kind, config }, secret);
        }
        vscode.window.showInformationMessage(`Connection '${name}' saved.`);
        vscode.commands.executeCommand('vura-sql.refreshSchema');
    }

    private async pushState(kind: 'init' | 'refresh') {
        const env = new VsCodeEnvironment(this.context);
        const [runtime, storage] = await Promise.all([
            getRuntimeStatus(this.context),
            getStorageStatus(env.storagePath)
        ]);

        // Awaited before computing `kinds` below: getAddonStatuses() force-activates any
        // installed-but-dormant connector extension, which is what makes it show up in
        // ProviderRegistry — without this order, kinds would still reflect pre-activation state.
        const addons = await getAddonStatuses();
        const pythonPackages = await Promise.all(PYTHON_PACKAGE_CATALOG.map(async pkg => ({
            ...pkg,
            installed: runtime.pythonBin ? await isPythonPackageInstalled(runtime.pythonBin, pkg.name) : false
        })));

        this.panel.webview.postMessage({
            type: kind,
            state: {
                runtime,
                storage,
                addons,
                pythonPackages,
                kinds: getConnectorKindDescriptors(),
                profiles: ConnectionManager.getAllConnectionProfiles(this.context),
                activeProfileId: ConnectionManager.getActiveProfileId(this.context),
                mirrorEnabled: ConnectionManager.isWorkspaceMirrorEnabled(this.context),
                cacheDirectoryConfigKey: CACHE_DIRECTORY_CONFIG_KEY
            }
        });
    }

    private dispose() {
        HubPanel.current = undefined;
        this.outputChannel.dispose();
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
