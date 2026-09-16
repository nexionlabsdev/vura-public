import * as vscode from 'vscode';
import * as path from 'path';
import { ProviderRegistry } from '@vura-data-os/core-sdk';
import { sidecarPool, DuckDbManager } from '@vura-data-os/vura-runner';
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

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async handleMessage(data: any) {
        switch (data.type) {
            case 'requestData':
                await this.pushState('init');
                break;
            case 'browseVenvPath': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Virtual Environment Folder',
                    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
                });
                if (!picked || picked.length === 0) break;
                const env = new VsCodeEnvironment(this.context);
                await env.setPythonVenvPath(picked[0].fsPath);
                await this.pushState('refresh');
                break;
            }
            case 'createVenv': {
                const env = new VsCodeEnvironment(this.context);
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage('Open a workspace folder before creating a virtual environment.');
                    break;
                }
                const folder = path.join(workspaceRoot, '.venv');
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
