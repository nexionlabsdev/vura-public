import * as vscode from 'vscode';
import { ProviderRegistry, ConnectionField, ConnectionProfile } from '@vura-data-os/core-sdk';
import { SqlService } from '@vura-data-os/vura-runner';
import { ConnectionManager, SqlProfile, AuthMode } from './connectionManager';
import { OutputChannelLogger } from './OutputChannelLogger';
import { safeRegisterCommand } from './commandUtils';
import { sharedConnectionFormCss, sharedConnectionFormScript } from './hub/connectionFormRenderer';
import { ADDON_CATALOG, ensureCatalogExtensionsActivated } from './hub/addonsCatalog';

export interface KindDescriptor {
    kind: string;
    label: string;
    description: string;
    fields: ConnectionField[];
    testable?: boolean;
    /** False for a known connector kind whose provider Add-on isn't installed/activated yet —
     *  still listed (so users know it exists and how to get it) but not configurable until then. */
    available?: boolean;
    /** VS Code extension id to install, when available === false. */
    installExtensionId?: string;
}

export const KIND_DISPLAY_NAMES: Record<string, string> = {
    sql: 'Microsoft SQL Server / Azure SQL',
    dataverse: 'Microsoft Dataverse',
    sharepoint: 'SharePoint',
    onedrive: 'OneDrive',
    googledrive: 'Google Drive',
    s3: 'Amazon S3',
    local: 'Local / Mapped Folder'
};

const KIND_DESCRIPTIONS: Record<string, string> = {
    sql: 'Connect to a SQL Server or Azure SQL database for SQL cells.',
    dataverse: 'Sync tables to and from a Microsoft Dataverse environment.',
    sharepoint: 'Sync SharePoint Lists, and import/export files from a document library.',
    onedrive: 'Import/export files from a specific user\'s OneDrive.',
    googledrive: 'Import/export files from Google Drive.',
    s3: 'Import/export objects from an Amazon S3 bucket.',
    local: 'Import/export files from a local folder or mapped/mounted drive outside the notebook directory.'
};

/**
 * The 'sql' kind isn't a registered IVuraProvider — SQL support is built into
 * core-extension/vura-runner directly — so its field schema is hardcoded here,
 * using the same showWhen-per-authMode branching the original SQL-only webview
 * (configViewProvider.ts) implemented by hand.
 */
const SQL_FIELDS: ConnectionField[] = [
    {
        key: 'authMode', label: 'Auth Mode', type: 'select', required: true, default: 'SqlLogin',
        options: ['SqlLogin', 'WindowsAuth', 'ServicePrincipal', 'DeviceCode']
    },
    { key: 'server', label: 'Server / Host', type: 'text', required: true, placeholder: 'localhost' },
    { key: 'port', label: 'Port', type: 'number', required: true, default: '1433' },
    { key: 'database', label: 'Database Name', type: 'text', required: true, placeholder: 'master' },
    { key: 'username', label: 'Username', type: 'text', required: true, showWhen: { field: 'authMode', equals: ['SqlLogin', 'WindowsAuth'] } },
    { key: 'domain', label: 'Domain', type: 'text', showWhen: { field: 'authMode', equals: 'WindowsAuth' } },
    { key: 'tenantId', label: 'Tenant ID / Directory ID', type: 'text', required: true, showWhen: { field: 'authMode', equals: ['ServicePrincipal', 'DeviceCode'] } },
    { key: 'clientId', label: 'Client ID (Application ID)', type: 'text', required: true, showWhen: { field: 'authMode', equals: ['ServicePrincipal', 'DeviceCode'] } },
    {
        key: 'secret', label: 'Password / Client Secret', type: 'password', secret: true, required: true,
        showWhen: { field: 'authMode', equals: ['SqlLogin', 'WindowsAuth', 'ServicePrincipal'] }
    }
];

/**
 * Every connector kind the host currently knows about — the built-in 'sql' kind plus
 * one entry per registered (and enabled) IVuraProvider that declares a connector kind.
 * Shared by the sidebar Connections webview and the Environment Hub's Connectors
 * section so the list-building logic (and its ProviderRegistry.getAllProviders()
 * disabled-provider filtering) exists in exactly one place.
 */
export function getConnectorKindDescriptors(): KindDescriptor[] {
    const kinds: KindDescriptor[] = [
        { kind: 'sql', label: KIND_DISPLAY_NAMES.sql, description: KIND_DESCRIPTIONS.sql, fields: SQL_FIELDS, testable: true }
    ];

    const providers = ProviderRegistry.getInstance().getAllProviders();
    for (const provider of providers) {
        const kind = provider.getConnectorKind?.();
        if (!kind || kind === 'sql') continue;
        kinds.push({
            kind,
            label: KIND_DISPLAY_NAMES[kind] || kind,
            description: KIND_DESCRIPTIONS[kind] || `Connect to ${kind}.`,
            fields: provider.getConnectionFields?.() || [],
            testable: !!provider.testConnection,
            available: true
        });
    }

    // Every other known connector kind (Dataverse, SharePoint, ...) still gets listed as a
    // disabled placeholder — its provider Add-on just isn't installed/activated in this VS
    // Code instance yet (Add-ons ship as separate extensions; see activateVsCodeProvider.ts).
    // Without this, a user who hasn't installed that extension can't even see the kind exists,
    // let alone find their way to installing it.
    for (const entry of ADDON_CATALOG) {
        if (kinds.some(k => k.kind === entry.kind)) continue;
        kinds.push({
            kind: entry.kind,
            label: entry.displayName,
            description: `${entry.description} Requires the "${entry.displayName}" Add-on extension (${entry.extensionId}) — install it from the Add-ons tab, then this type becomes configurable.`,
            fields: [],
            testable: false,
            available: false,
            installExtensionId: entry.extensionId
        });
    }

    return kinds;
}

/** Runs the SQL 'ping' probe (list online databases) against unsaved config — used by both the sidebar's Test button and the Hub's generic dispatcher below. */
export async function testSqlConfig(config: Record<string, any>, secret: string | undefined): Promise<{ success: boolean; databases?: string[]; error?: string }> {
    const tempProfile: SqlProfile = {
        id: '__temp__',
        name: '__temp__',
        authMode: config.authMode as AuthMode,
        server: config.server,
        database: 'master',
        port: config.port ? parseInt(config.port, 10) : 1433,
        clientId: config.clientId,
        tenantId: config.tenantId,
        username: config.username,
        domain: config.domain
    };
    const channel = vscode.window.createOutputChannel('Vura Connections');
    try {
        const logger = new OutputChannelLogger(channel);
        const service = new SqlService(tempProfile, secret || undefined);
        const rows = await service.executeSql(
            `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`, logger
        );
        const dbNames: string[] = rows.map((r: any) => r['name'] || r['Name']);
        return { success: true, databases: dbNames };
    } catch (err: any) {
        return { success: false, error: err.message };
    } finally {
        channel.dispose();
    }
}

/**
 * Generic "Test Connection" dispatcher for the Environment Hub's Connectors section:
 * SQL keeps its bespoke metadata-probe (list online databases); every other kind
 * routes to that provider's optional IVuraProvider.testConnection, when implemented.
 */
export async function testConnectorConfig(kind: string, config: Record<string, any>, secret: string | undefined): Promise<{ success: boolean; message: string }> {
    if (kind === 'sql') {
        const result = await testSqlConfig(config, secret);
        return result.success
            ? { success: true, message: `Connected. ${(result.databases || []).length} database(s) found.` }
            : { success: false, message: result.error || 'Connection failed.' };
    }
    const provider = ProviderRegistry.getInstance().getAllProviders().find(p => p.getConnectorKind?.() === kind);
    if (!provider?.testConnection) {
        return { success: false, message: 'Test Connection is not supported for this connector.' };
    }
    try {
        return await provider.testConnection(config, secret);
    } catch (err: any) {
        return { success: false, message: err?.message || 'Test failed.' };
    }
}

/**
 * Single, provider-agnostic sidebar for every connection type — SQL Server
 * included. Selecting a connector type swaps in that connector's declared
 * field schema (IVuraProvider.getConnectionFields()); adding a brand new
 * connector kind never requires touching this file.
 */
export class ConnectionsConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vura-connections.configView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'requestData': {
                    await this._sendDataToWebview();
                    break;
                }
                case 'saveConnection': {
                    await this._saveConnection(data);
                    this._sendProfilesToWebview();
                    break;
                }
                case 'deleteConnection': {
                    await ConnectionManager.removeAnyConnectionProfile(this._context, data.id);
                    vscode.window.showInformationMessage('Connection deleted.');
                    this._sendProfilesToWebview();
                    break;
                }
                case 'testConnection': {
                    // A blank secret on an existing (non-new) profile means "unchanged" —
                    // the form never re-populates secret fields, so without this a Test
                    // Connection on an already-saved profile would always fail auth.
                    let secret = data.secret;
                    if (!secret && !data.isNewProfile && data.id) {
                        secret = await ConnectionManager.getSecretForConnectionProfile(this._context, data.id);
                    }
                    const result = await testConnectorConfig(data.kind, data.config, secret);
                    this._view?.webview.postMessage({ type: 'connTestResult', ...result });
                    break;
                }
                case 'installProviderExtension': {
                    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${data.extensionId}`);
                    break;
                }
                case 'browseConnectionField': {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Select Folder',
                        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
                    });
                    this._view?.webview.postMessage({
                        type: 'browseConnectionFieldResult',
                        key: data.key,
                        path: picked && picked.length > 0 ? picked[0].fsPath : undefined
                    });
                    break;
                }
            }
        });

        safeRegisterCommand('vura-connections.refreshConfigurationPanel', () => {
            void this._sendDataToWebview();
        });
    }

    private async _saveConnection(data: { id: string; name: string; kind: string; config: Record<string, any>; secret?: string }) {
        const { id, name, kind, config, secret } = data;

        if (kind === 'sql') {
            const profile: SqlProfile = {
                id,
                name,
                authMode: config.authMode as AuthMode,
                server: config.server,
                database: config.database,
                port: config.port ? parseInt(config.port, 10) : 1433,
                clientId: config.clientId || undefined,
                tenantId: config.tenantId || undefined,
                username: config.username || undefined,
                domain: config.domain || undefined
            };
            await ConnectionManager.saveProfile(this._context, profile, secret);
        } else {
            await ConnectionManager.saveConnectionProfile(this._context, { id, name, kind, config }, secret);
        }
        vscode.window.showInformationMessage(`Connection '${name}' saved.`);
        vscode.commands.executeCommand('vura-sql.refreshSchema');
    }

    private _getKinds(): KindDescriptor[] {
        return getConnectorKindDescriptors();
    }

    private async _sendDataToWebview() {
        // Force-activate any installed-but-dormant connector extension first (see
        // ensureCatalogExtensionsActivated in hub/addonsCatalog.ts) so a connector kind
        // whose extension hasn't happened to activate yet (e.g. no notebook opened) still
        // shows up here instead of looking uninstalled.
        await ensureCatalogExtensionsActivated();
        this._view?.webview.postMessage({
            type: 'init',
            kinds: this._getKinds(),
            // A single flat list across every kind (SQL included) — includes the
            // legacy-SqlProfile-as-Dataverse bridge (see
            // ConnectionManager.getAllConnectionProfiles) so pre-migration
            // Dataverse connections show up here too; saving one through this
            // panel upgrades it to a first-class 'dataverse' ConnectionProfile.
            profiles: ConnectionManager.getAllConnectionProfiles(this._context)
        });
    }

    private _sendProfilesToWebview() {
        this._view?.webview.postMessage({
            type: 'loadAllProfiles',
            profiles: ConnectionManager.getAllConnectionProfiles(this._context)
        });
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body {
    padding: 10px 12px 20px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  label { display: block; margin-bottom: 3px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  label .req { color: var(--vscode-errorForeground, #f14c4c); margin-left: 2px; }
  input, select {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
    outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  input.invalid { border-color: var(--vscode-errorForeground, #f14c4c); }
  select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .row { margin-bottom: 10px; }
  .help { color: var(--vscode-descriptionForeground); font-size: 0.78em; margin-top: 3px; }
  .section-title {
    font-size: 0.75em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 14px 0 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .kind-desc {
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    margin: 2px 0 12px;
    line-height: 1.4;
  }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 10px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border-radius: 2px;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon { background: transparent; color: var(--vscode-foreground); padding: 4px 6px; font-size: 1em; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.link {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    padding: 4px 0;
    font-size: 0.85em;
  }
  button.link:hover { color: var(--vscode-textLink-activeForeground); background: transparent; text-decoration: underline; }
  .btn-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .btn-row button { flex: 1; min-width: 90px; }
  .profile-row { display: flex; gap: 6px; align-items: center; }
  .profile-row select { flex: 1; }
  .fixed-value {
    padding: 4px 6px;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid transparent;
    border-radius: 2px;
    opacity: 0.85;
  }
  .validation-summary {
    display: none;
    font-size: 0.8em;
    color: var(--vscode-errorForeground, #f14c4c);
    margin-top: 10px;
    padding: 6px 8px;
    background: rgba(241, 76, 76, 0.08);
    border: 1px solid rgba(241, 76, 76, 0.25);
    border-radius: 3px;
  }
  .test-result { font-size: 0.82em; margin-top: 8px; white-space: pre-wrap; }
  .test-result.ok { color: #51cf66; }
  .test-result.err { color: var(--vscode-errorForeground, #f14c4c); }
  .empty { color: var(--vscode-descriptionForeground); font-size: 0.85em; padding: 12px 0; }
  ${sharedConnectionFormCss()}
</style>
</head>
<body>
<script>${sharedConnectionFormScript()}</script>

<div id="noKinds" class="empty" style="display:none">
  No connectors registered.
</div>

<div id="formArea">
  <div class="row">
    <label><strong>Connection</strong></label>
    <div class="profile-row">
      <select id="profileSelect"></select>
    </div>
  </div>

  <div class="row">
    <button class="link" id="newProfileBtn">+ New Connector</button>
  </div>

  <hr/>

  <div class="row">
    <label>Name<span class="req">*</span></label>
    <input type="text" id="connName" placeholder="e.g. Production Database"/>
  </div>

  <div class="row">
    <label>Type<span class="req">*</span></label>
    <select id="kindSelect"></select>
    <div class="fixed-value" id="kindFixed" style="display:none"></div>
    <div class="kind-desc" id="kindDesc"></div>
  </div>

  <div id="fieldsArea"></div>

  <div class="validation-summary" id="validationSummary"></div>

  <div id="sqlTestResult" class="test-result"></div>

  <div class="btn-row">
    <button id="saveBtn">Save Connection</button>
    <button class="secondary" id="testBtn" style="display:none">Test Connection</button>
    <button class="secondary" id="deleteBtn">Delete</button>
    <button class="secondary" id="installExtBtn" style="display:none">Install Extension</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let kinds = [];
  let allProfiles = [];
  let currentKind = '';
  let currentProfileId = '';
  let isNewProfile = false;
  let fieldValues = {};
  let lastSelectedProfileId = '';

  window.addEventListener('load', () => vscode.postMessage({ type: 'requestData' }));

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'init') {
      kinds = msg.kinds;
      allProfiles = msg.profiles;
      if (kinds.length === 0) {
        document.getElementById('noKinds').style.display = 'block';
        document.getElementById('formArea').style.display = 'none';
        return;
      }
      document.getElementById('noKinds').style.display = 'none';
      document.getElementById('formArea').style.display = 'block';
      populateKindSelect();
      renderProfileList();
    } else if (msg.type === 'loadAllProfiles') {
      allProfiles = msg.profiles;
      renderProfileList();
    } else if (msg.type === 'connTestResult') {
      showTestResult(msg);
    } else if (msg.type === 'browseConnectionFieldResult') {
      if (msg.path) {
        fieldValues[msg.key] = msg.path;
        renderFields();
      }
    }
  });

  function populateKindSelect() {
    const sel = document.getElementById('kindSelect');
    sel.innerHTML = '';
    kinds.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.kind;
      opt.textContent = k.label;
      sel.appendChild(opt);
    });
  }

  function currentKindInfo() {
    return kinds.find(k => k.kind === currentKind) || { fields: [] };
  }

  function updateTypeDisplay() {
    const desc = kinds.find(k => k.kind === currentKind);
    document.getElementById('kindDesc').textContent = desc ? desc.description : '';

    const unavailable = !!(desc && desc.available === false);
    // Every connector kind gets a Test Connection option — even one this host can't
    // probe yet (testConnectorConfig() replies "not supported" rather than the button
    // just not existing, so the user always has a way to find out).
    document.getElementById('testBtn').style.display = unavailable ? 'none' : 'block';
    const installBtn = document.getElementById('installExtBtn');
    installBtn.style.display = unavailable ? 'block' : 'none';
    installBtn.dataset.extId = unavailable ? desc.installExtensionId : '';
    document.getElementById('saveBtn').disabled = unavailable;
    document.getElementById('fieldsArea').style.display = unavailable ? 'none' : 'block';

    document.getElementById('deleteBtn').textContent = isNewProfile ? 'Cancel' : 'Delete';

    // New connectors: type is a choice. Existing ones: type is fixed — the
    // config fields it was saved with only make sense for that one kind.
    document.getElementById('kindSelect').style.display = isNewProfile ? 'block' : 'none';
    const fixedEl = document.getElementById('kindFixed');
    fixedEl.style.display = isNewProfile ? 'none' : 'block';
    if (!isNewProfile) fixedEl.textContent = desc ? desc.label : currentKind;
  }

  document.getElementById('installExtBtn').addEventListener('click', e => {
    const extId = e.target.dataset.extId;
    if (extId) vscode.postMessage({ type: 'installProviderExtension', extensionId: extId });
  });

  document.getElementById('kindSelect').addEventListener('change', e => {
    currentKind = e.target.value;
    fieldValues = {};
    const fields = currentKindInfo().fields || [];
    fields.forEach(f => { if (f.default !== undefined) fieldValues[f.key] = f.default; });
    updateTypeDisplay();
    document.getElementById('sqlTestResult').textContent = '';
    renderFields();
  });

  function profileLabel(p) {
    const k = kinds.find(k => k.kind === p.kind);
    return p.name + ' (' + (k ? k.label : p.kind) + ')';
  }

  function renderProfileList() {
    const sel = document.getElementById('profileSelect');
    const prevId = currentProfileId;
    sel.innerHTML = '';

    const newOpt = document.createElement('option');
    newOpt.value = '';
    newOpt.textContent = '+ New Connector';
    sel.appendChild(newOpt);

    allProfiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = profileLabel(p);
      sel.appendChild(opt);
    });

    const stillExists = allProfiles.some(p => p.id === prevId);
    if (!isNewProfile && stillExists) {
      sel.value = prevId;
      populateForm(allProfiles.find(p => p.id === prevId));
    } else if (allProfiles.length > 0 && !isNewProfile) {
      sel.value = allProfiles[0].id;
      populateForm(allProfiles[0]);
    } else {
      sel.value = '';
      startNewProfile();
    }
  }

  document.getElementById('profileSelect').addEventListener('change', e => {
    if (!e.target.value) { startNewProfile(); return; }
    const p = allProfiles.find(p => p.id === e.target.value);
    if (p) populateForm(p);
  });

  document.getElementById('newProfileBtn').addEventListener('click', () => {
    document.getElementById('profileSelect').value = '';
    startNewProfile();
  });

  function isFieldVisible(field) {
    return window.VuraConnForm.isFieldVisible(field, fieldValues);
  }

  function renderFields() {
    const area = document.getElementById('fieldsArea');
    const fields = currentKindInfo().fields || [];
    window.VuraConnForm.renderFields(area, fields, fieldValues, isNewProfile, onFieldChange, onBrowseFolder);
    validate();
  }

  function onBrowseFolder(field) {
    vscode.postMessage({ type: 'browseConnectionField', key: field.key });
  }

  function onFieldChange(field) {
    const el = document.getElementById('field_' + field.key);
    fieldValues[field.key] = el.value;
    if (field.type === 'select') {
      // A controlling field (e.g. authMode) changing may show/hide other fields.
      renderFields();
    } else {
      validate();
    }
  }

  function populateForm(p) {
    currentProfileId = p.id;
    lastSelectedProfileId = p.id;
    isNewProfile = false;
    currentKind = p.kind;
    document.getElementById('connName').value = p.name || '';
    fieldValues = {};
    const fields = currentKindInfo().fields || [];
    fields.forEach(f => {
      if (!f.secret) fieldValues[f.key] = (p.config && p.config[f.key] !== undefined && p.config[f.key] !== null) ? String(p.config[f.key]) : (f.default || '');
    });
    document.getElementById('sqlTestResult').textContent = '';
    updateTypeDisplay();
    renderFields();
  }

  function startNewProfile() {
    isNewProfile = true;
    currentKind = kinds[0].kind;
    currentProfileId = currentKind + '-' + Date.now().toString().slice(-6);
    document.getElementById('connName').value = '';
    document.getElementById('kindSelect').value = currentKind;
    fieldValues = {};
    const fields = currentKindInfo().fields || [];
    fields.forEach(f => { if (f.default !== undefined) fieldValues[f.key] = f.default; });
    document.getElementById('sqlTestResult').textContent = '';
    updateTypeDisplay();
    renderFields();
  }

  function validate() {
    const fields = currentKindInfo().fields || [];
    const connNameVal = document.getElementById('connName').value.trim();
    const ok = window.VuraConnForm.validate(
      fields, fieldValues, isNewProfile,
      document.getElementById('validationSummary'),
      document.getElementById('saveBtn'),
      [{ label: 'Connection Name', value: connNameVal }]
    );
    if (currentKindInfo().available === false) {
      document.getElementById('saveBtn').disabled = true;
      return false;
    }
    return ok;
  }

  document.getElementById('connName').addEventListener('input', validate);

  function collectConfigAndSecret() {
    const fields = currentKindInfo().fields || [];
    return window.VuraConnForm.collectConfigAndSecret(fields);
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    if (!validate()) return;
    const name = document.getElementById('connName').value.trim();
    const { config, secret } = collectConfigAndSecret();
    vscode.postMessage({ type: 'saveConnection', id: currentProfileId, name, kind: currentKind, config, secret });
    // Optimistic: the connection now exists, so its type becomes fixed and the
    // next profile-list refresh should re-select it instead of bouncing back
    // to a blank "new connector" form.
    isNewProfile = false;
    updateTypeDisplay();
  });

  function cancelNewProfile() {
    const target = allProfiles.find(p => p.id === lastSelectedProfileId) || allProfiles[0];
    if (target) {
      document.getElementById('profileSelect').value = target.id;
      populateForm(target);
    } else {
      document.getElementById('profileSelect').value = '';
      startNewProfile();
    }
  }

  document.getElementById('deleteBtn').addEventListener('click', () => {
    if (isNewProfile) {
      cancelNewProfile();
      return;
    }
    if (currentProfileId) {
      vscode.postMessage({ type: 'deleteConnection', id: currentProfileId, kind: currentKind });
    }
  });

  document.getElementById('testBtn').addEventListener('click', () => {
    const { config, secret } = collectConfigAndSecret();
    document.getElementById('sqlTestResult').textContent = 'Testing…';
    document.getElementById('sqlTestResult').className = 'test-result';
    vscode.postMessage({ type: 'testConnection', kind: currentKind, id: currentProfileId, isNewProfile, config, secret });
  });

  function showTestResult(msg) {
    const el = document.getElementById('sqlTestResult');
    el.className = 'test-result ' + (msg.success ? 'ok' : 'err');
    el.textContent = (msg.success ? '✓ ' : '✗ ') + msg.message;
  }
</script>
</body>
</html>`;
    }
}
