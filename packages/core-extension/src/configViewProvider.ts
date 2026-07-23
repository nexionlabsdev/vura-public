import * as vscode from 'vscode';
import { ConnectionManager, SqlProfile, AuthMode } from './connectionManager';
import { SqlService } from '@vura-data-os/vura-runner';
import { OutputChannelLogger } from './OutputChannelLogger';

export class ConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vura-sql.configView';
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
                case 'saveConfig': {
                    const profile: SqlProfile = {
                        id: data.profileId,
                        name: data.profileName,
                        authMode: data.authMode as AuthMode,
                        server: data.server,
                        database: data.database,
                        port: data.port ? parseInt(data.port) : 1433,
                        clientId: data.clientId,
                        tenantId: data.tenantId,
                        username: data.username,
                        domain: data.domain
                    };
                    await ConnectionManager.saveProfile(this._context, profile, data.secretPayload);
                    vscode.window.showInformationMessage(`Profile '${profile.name}' saved.`);
                    vscode.commands.executeCommand('vura-sql.refreshSchema');
                    this._sendDataToWebview();
                    break;
                }
                case 'requestData': {
                    this._sendDataToWebview();
                    break;
                }
                case 'selectProfile': {
                    await ConnectionManager.setActiveProfile(this._context, data.profileId);
                    vscode.commands.executeCommand('vura-sql.refreshSchema');
                    this._sendDataToWebview();
                    break;
                }
                case 'deleteProfile': {
                    await ConnectionManager.removeProfile(this._context, data.profileId);
                    vscode.window.showInformationMessage('Profile deleted.');
                    this._sendDataToWebview();
                    break;
                }
                case 'loadDatabases': {
                    const tempProfile: SqlProfile = {
                        id: '__temp__',
                        name: '__temp__',
                        authMode: data.authMode as AuthMode,
                        server: data.server,
                        database: 'master',
                        port: data.port ? parseInt(data.port) : 1433,
                        clientId: data.clientId,
                        tenantId: data.tenantId,
                        username: data.username,
                        domain: data.domain
                    };
                    try {
                        const channel = vscode.window.createOutputChannel('Vura DB Loader');
                        const logger = new OutputChannelLogger(channel);
                        const service = new SqlService(tempProfile, data.secretPayload || undefined);
                        const rows = await service.executeSql(
                            `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`, logger
                        );
                        channel.dispose();
                        const dbNames: string[] = rows.map((r: any) => r['name'] || r['Name']);
                        this._view?.webview.postMessage({ type: 'databaseList', databases: dbNames });
                    } catch (err: any) {
                        vscode.window.showErrorMessage('Failed to load databases: ' + err.message);
                        this._view?.webview.postMessage({ type: 'databaseList', databases: [], error: err.message });
                    }
                    break;
                }
            }
        });

        vscode.commands.registerCommand('vura-sql.refreshConfigurationPanel', () => {
            this._sendDataToWebview();
        });
    }

    private _sendDataToWebview() {
        const profiles = ConnectionManager.getProfiles(this._context);
        const activeProfile = ConnectionManager.getActiveProfile(this._context);
        this._view?.webview.postMessage({ type: 'loadData', profiles, activeProfile });
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body {
    padding: 10px 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  label {
    display: block;
    margin-bottom: 3px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  input, select, textarea {
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
  input:focus, select:focus {
    border-color: var(--vscode-focusBorder);
  }
  input[type="password"] { letter-spacing: 0.1em; }
  select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .row { margin-bottom: 10px; }
  .inline { display: flex; gap: 8px; }
  .inline .row { flex: 1; }
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
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon {
    background: transparent;
    color: var(--vscode-foreground);
    padding: 4px 6px;
    font-size: 1em;
  }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn-row { display: flex; gap: 8px; margin-top: 14px; }
  .btn-row button { flex: 1; }
  .profile-row { display: flex; gap: 6px; align-items: center; }
  .profile-row select { flex: 1; }
  .db-row { display: flex; gap: 6px; align-items: center; }
  .db-row input { flex: 1; }
  .hidden { display: none !important; }
  small { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-top: 2px; display: block; }
</style>
</head>
<body>

<div class="row">
  <label><strong>Active Profile</strong></label>
  <div class="profile-row">
    <select id="profileSelect"></select>
    <button class="icon" id="newProfileBtn" title="New Profile">＋</button>
  </div>
</div>

<hr/>

<div class="row">
  <label>Profile Name</label>
  <input type="text" id="profileName" placeholder="e.g. Production MSSQL"/>
</div>

<div class="section-title">Server</div>

<div class="row">
  <label>Auth Mode</label>
  <select id="authMode">
    <option value="SqlLogin">SQL Login (Username &amp; Password)</option>
    <option value="WindowsAuth">Windows Auth / NTLM</option>
    <option value="ServicePrincipal">Service Principal (Client ID &amp; Secret)</option>
    <option value="DeviceCode">MFA / Interactive (Device Code)</option>
  </select>
</div>

<div class="inline">
  <div class="row" style="flex:3">
    <label>Server / Host</label>
    <input type="text" id="server" placeholder="localhost"/>
  </div>
  <div class="row" style="flex:1">
    <label>Port</label>
    <input type="number" id="port" value="1433"/>
  </div>
</div>

<div class="row hidden" id="section-tenantId">
  <label>Tenant ID / Directory ID</label>
  <input type="text" id="tenantId"/>
</div>

<div class="row hidden" id="section-clientId">
  <label>Client ID (Application ID)</label>
  <input type="text" id="clientId"/>
</div>

<div class="row hidden" id="section-username">
  <label>Username</label>
  <input type="text" id="username"/>
</div>

<div class="row hidden" id="section-domain">
  <label>Domain (optional)</label>
  <input type="text" id="domain" placeholder="CORP"/>
</div>

<div class="row hidden" id="section-secret">
  <label id="secretLabel">Password / Client Secret</label>
  <input type="password" id="secretPayload" placeholder="Leave blank to keep unchanged"/>
</div>

<div class="section-title">Database</div>

<div class="row">
  <label>Database Name</label>
  <div class="db-row">
    <input type="text" id="database" placeholder="master" list="databaseList" autocomplete="off"/>
    <datalist id="databaseList"></datalist>
    <button class="secondary" id="loadDbBtn" title="Connect and fetch available databases" style="white-space:nowrap;flex-shrink:0">Load</button>
  </div>
  <small id="dbLoadStatus"></small>
</div>

<div class="btn-row">
  <button id="saveBtn">Save Profile</button>
  <button class="secondary" id="deleteBtn">Delete</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let isNewProfile = false;
  let currentProfileId = '';

  window.addEventListener('load', () => vscode.postMessage({ type: 'requestData' }));

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'loadData') {
      renderProfileList(msg.profiles, msg.activeProfile);
    } else if (msg.type === 'databaseList') {
      onDatabasesLoaded(msg.databases, msg.error);
    }
  });

  function renderProfileList(profiles, activeProfile) {
    const sel = document.getElementById('profileSelect');
    sel.innerHTML = '';

    if (!profiles || profiles.length === 0) {
      startNewProfile();
      return;
    }

    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });

    isNewProfile = false;
    const target = activeProfile || profiles[0];
    sel.value = target.id;
    populateForm(target);
  }

  function populateForm(p) {
    currentProfileId = p.id;
    document.getElementById('profileName').value = p.name || '';
    document.getElementById('authMode').value = p.authMode || 'SqlLogin';
    document.getElementById('server').value = p.server || '';
    document.getElementById('port').value = p.port || '1433';
    document.getElementById('database').value = p.database || '';
    document.getElementById('clientId').value = p.clientId || '';
    document.getElementById('tenantId').value = p.tenantId || '';
    document.getElementById('username').value = p.username || '';
    document.getElementById('domain').value = p.domain || '';
    document.getElementById('secretPayload').value = '';
    resetDatabaseDropdown();
    document.getElementById('dbLoadStatus').textContent = '';
    updateFormVisibility();
  }

  function startNewProfile() {
    isNewProfile = true;
    currentProfileId = 'profile-' + Date.now();
    document.getElementById('profileName').value = 'New Profile';
    document.getElementById('authMode').value = 'SqlLogin';
    document.getElementById('server').value = '';
    document.getElementById('port').value = '1433';
    document.getElementById('database').value = 'master';
    document.getElementById('clientId').value = '';
    document.getElementById('tenantId').value = '';
    document.getElementById('username').value = '';
    document.getElementById('domain').value = '';
    document.getElementById('secretPayload').value = '';
    resetDatabaseDropdown();
    document.getElementById('dbLoadStatus').textContent = '';
    updateFormVisibility();
  }

  function resetDatabaseDropdown() {
    document.getElementById('databaseList').innerHTML = '';
    document.getElementById('dbLoadStatus').textContent = '';
  }

  function onDatabasesLoaded(databases, error) {
    const list = document.getElementById('databaseList');
    const status = document.getElementById('dbLoadStatus');

    list.innerHTML = '';
    if (error) {
      status.textContent = '⚠ ' + error;
      return;
    }
    if (!databases || databases.length === 0) {
      status.textContent = 'No databases found.';
      return;
    }
    databases.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    });
    status.textContent = databases.length + ' databases loaded — type or pick from list.';
  }

  document.getElementById('loadDbBtn').addEventListener('click', () => {
    document.getElementById('dbLoadStatus').textContent = 'Connecting…';
    resetDatabaseDropdown();
    vscode.postMessage({
      type: 'loadDatabases',
      authMode: document.getElementById('authMode').value,
      server: document.getElementById('server').value,
      port: document.getElementById('port').value,
      clientId: document.getElementById('clientId').value,
      tenantId: document.getElementById('tenantId').value,
      username: document.getElementById('username').value,
      domain: document.getElementById('domain').value,
      secretPayload: document.getElementById('secretPayload').value
    });
  });

  document.getElementById('newProfileBtn').addEventListener('click', startNewProfile);

  document.getElementById('profileSelect').addEventListener('change', e => {
    const id = e.target.value;
    if (id) vscode.postMessage({ type: 'selectProfile', profileId: id });
  });

  document.getElementById('authMode').addEventListener('change', updateFormVisibility);

  function updateFormVisibility() {
    const mode = document.getElementById('authMode').value;
    document.querySelectorAll('[id^="section-"]').forEach(el => el.classList.add('hidden'));

    if (mode === 'ServicePrincipal') {
      show('section-tenantId'); show('section-clientId'); show('section-secret');
      document.getElementById('secretLabel').textContent = 'Client Secret';
    } else if (mode === 'DeviceCode') {
      show('section-tenantId'); show('section-clientId');
    } else if (mode === 'SqlLogin') {
      show('section-username'); show('section-secret');
      document.getElementById('secretLabel').textContent = 'SQL Password';
    } else if (mode === 'WindowsAuth') {
      show('section-domain'); show('section-username'); show('section-secret');
      document.getElementById('secretLabel').textContent = 'Windows Password';
    }
  }

  function show(id) { document.getElementById(id).classList.remove('hidden'); }

  document.getElementById('saveBtn').addEventListener('click', () => {
    const name = document.getElementById('profileName').value.trim();
    if (!name) { alert('Profile name is required.'); return; }
    let id = currentProfileId;
    if (isNewProfile) {
      id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString().slice(-4);
    }
    vscode.postMessage({
      type: 'saveConfig',
      profileId: id,
      profileName: name,
      authMode: document.getElementById('authMode').value,
      server: document.getElementById('server').value,
      database: document.getElementById('database').value,
      port: document.getElementById('port').value,
      clientId: document.getElementById('clientId').value,
      tenantId: document.getElementById('tenantId').value,
      username: document.getElementById('username').value,
      domain: document.getElementById('domain').value,
      secretPayload: document.getElementById('secretPayload').value
    });
  });

  document.getElementById('deleteBtn').addEventListener('click', () => {
    if (currentProfileId && !isNewProfile) {
      vscode.postMessage({ type: 'deleteProfile', profileId: currentProfileId });
    }
  });
</script>
</body>
</html>`;
    }
}
