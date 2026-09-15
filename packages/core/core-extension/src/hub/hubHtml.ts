import { sharedConnectionFormCss, sharedConnectionFormScript } from './connectionFormRenderer';

/**
 * The Environment Hub's full-tab shell: a left-rail nav over four sections
 * (Overview, Runtimes, Connectors, Add-ons, Storage), all rendered up front
 * and toggled client-side — the extension host pushes one `init` payload
 * plus targeted refreshes (`runtimeUpdate`, `profilesUpdate`, ...) rather
 * than re-rendering HTML per click. Vanilla JS/CSS, no bundler, matching
 * every other webview in this extension.
 */
export function getHubHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
  }
  #nav {
    width: 200px;
    flex-shrink: 0;
    border-right: 1px solid var(--vscode-panel-border);
    padding: 12px 0;
  }
  #nav .brand { font-weight: 700; padding: 4px 16px 12px; letter-spacing: 0.03em; }
  #nav .item {
    padding: 7px 16px;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.8;
    font-size: 0.92em;
  }
  #nav .item:hover { background: var(--vscode-list-hoverBackground); }
  #nav .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); opacity: 1; }
  #main { flex: 1; overflow-y: auto; padding: 24px 32px; max-width: 900px; }
  h2 { margin-top: 0; font-size: 1.3em; }
  h3 { font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 24px 0 10px; }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 14px 16px;
    margin-bottom: 10px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .card-title { font-weight: 600; display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
  .row-flex { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 10px; font-size: 0.8em; font-weight: 600; }
  .pill.ok { background: rgba(43, 181, 90, 0.16); color: #2bb55a; }
  .pill.warn { background: rgba(241, 172, 76, 0.16); color: #d99a3a; }
  .pill.err { background: rgba(241, 76, 76, 0.16); color: var(--vscode-errorForeground, #f14c4c); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 12px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border-radius: 2px;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground, #f14c4c); border: 1px solid var(--vscode-errorForeground, #f14c4c); }
  input[type=text], select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 0.85em; }
  .section { display: none; }
  .section.active { display: block; }
  .empty-note { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 0; }
  .usage-bar { height: 8px; border-radius: 4px; background: var(--vscode-input-background); overflow: hidden; margin: 8px 0; }
  .usage-bar-fill { height: 100%; background: var(--vscode-progressBar-background, #3794ff); }
  .toggle { display: flex; align-items: center; gap: 8px; }
  ${sharedConnectionFormCss()}
</style>
</head>
<body>
<script>${sharedConnectionFormScript()}</script>

<div id="nav">
  <div class="brand">VURA Hub</div>
  <div class="item active" data-section="overview">Overview</div>
  <div class="item" data-section="runtime">Runtimes</div>
  <div class="item" data-section="connectors">Connectors</div>
  <div class="item" data-section="addons">Add-ons</div>
  <div class="item" data-section="storage">Storage</div>
</div>

<div id="main">

  <div class="section active" id="section-overview">
    <h2>Environment &amp; Runtime Readiness</h2>
    <div id="overviewCards"></div>
  </div>

  <div class="section" id="section-runtime">
    <h2>Python Environment</h2>
    <div class="card">
      <div class="card-title">Interpreter <span id="pyStatusPill"></span></div>
      <div class="row-flex" style="margin-top:8px">
        <input type="text" id="venvPathInput" placeholder="Path to virtual environment" style="flex:1;min-width:220px" readonly>
        <button class="secondary" id="browseVenvBtn">Browse...</button>
        <button class="secondary" id="autoDetectBtn">Auto-Detect</button>
        <button class="secondary" id="createVenvBtn">Create venv here</button>
      </div>
      <div class="muted" id="pyVersionLine" style="margin-top:6px"></div>
      <div class="row-flex" style="margin-top:10px">
        <span id="bridgeStatusPill" class="pill"></span>
        <button id="installBridgeBtn">Install bridge into venv</button>
      </div>
      <div class="muted" id="venvGuardNote" style="margin-top:6px"></div>
    </div>

    <h2>Node.js Environment</h2>
    <div class="card">
      <div class="card-title">Runtime <span class="pill ok">Ready</span></div>
      <div class="muted" id="nodeVersionLine" style="margin-top:6px"></div>
    </div>

    <h3>Active Sessions</h3>
    <div id="sessionsArea"></div>

    <div class="row-flex" style="margin-top:12px">
      <button class="secondary" id="retestBtn">Re-test All Services</button>
      <button class="secondary" id="viewLogsBtn">View Diagnostic Logs</button>
    </div>
  </div>

  <div class="section" id="section-connectors">
    <h2>Workspace Connections &amp; Adapters</h2>
    <div class="row-flex">
      <select id="connProfileSelect" style="min-width:220px"></select>
      <button class="secondary" id="connNewBtn">+ New Connector</button>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row-flex">
        <div style="flex:1">
          <label class="muted">Name</label>
          <input type="text" id="connName" style="width:100%">
        </div>
        <div style="flex:1">
          <label class="muted">Type</label>
          <select id="connKindSelect" style="width:100%"></select>
        </div>
      </div>
      <div class="muted" id="connKindDesc" style="margin:6px 0"></div>
      <div id="connFieldsArea"></div>
      <div class="vcf-validation-summary" id="connValidationSummary"></div>
      <div class="muted" id="connTestResult" style="margin-top:6px"></div>
      <div class="row-flex" style="margin-top:12px">
        <button id="connSaveBtn">Save Connection</button>
        <button class="secondary" id="connTestBtn">Test Connection</button>
        <button class="danger" id="connDeleteBtn">Delete</button>
        <button class="secondary" id="connInstallExtBtn" style="display:none">Install Extension</button>
      </div>
    </div>
    <div class="toggle" style="margin-top:14px">
      <input type="checkbox" id="mirrorToggle">
      <label for="mirrorToggle" class="muted">Track connections in <code>.vura/connections.json</code> (git) — secrets are never written to this file</label>
    </div>
  </div>

  <div class="section" id="section-addons">
    <h2>Add-on Marketplace</h2>
    <h3>Provider Extensions</h3>
    <div id="providerAddonsArea"></div>
    <h3>Python Packages</h3>
    <div id="pythonPackagesArea"></div>
  </div>

  <div class="section" id="section-storage">
    <h2>Engine &amp; Scratch Storage</h2>
    <div class="card">
      <div class="muted" id="storageDirLine"></div>
      <div class="usage-bar"><div class="usage-bar-fill" id="usageBarFill" style="width:0%"></div></div>
      <div id="storageUsedLine"></div>
      <button class="danger" id="purgeBtn" style="margin-top:10px">Purge Temp Files</button>
    </div>
  </div>

</div>

<script>
  const vscode = acquireVsCodeApi();
  let state = null;
  let conn = { kinds: [], profiles: [], currentKind: '', currentProfileId: '', isNewProfile: true, fieldValues: {}, lastSelectedProfileId: '' };

  document.querySelectorAll('#nav .item').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#nav .item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('section-' + el.dataset.section).classList.add('active');
    });
  });

  window.addEventListener('load', () => vscode.postMessage({ type: 'requestData' }));

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'init' || msg.type === 'refresh') {
      state = msg.state;
      conn.kinds = state.kinds;
      conn.profiles = state.profiles;
      renderOverview();
      renderRuntime();
      renderConnectors();
      renderAddons();
      renderStorage();
    } else if (msg.type === 'connTestResult') {
      const el = document.getElementById('connTestResult');
      el.textContent = (msg.success ? '✓ ' : '✗ ') + msg.message;
      el.style.color = msg.success ? '#2bb55a' : 'var(--vscode-errorForeground)';
    } else if (msg.type === 'toast') {
      const el = document.getElementById('pyVersionLine');
      // lightweight inline notice; full messages also surface as VS Code notifications from the host
    } else if (msg.type === 'browseConnectionFieldResult') {
      if (msg.path) {
        conn.fieldValues[msg.key] = msg.path;
        renderConnFields();
      }
    }
  });

  function pill(text, level) {
    return '<span class="pill ' + level + '">' + text + '</span>';
  }

  function renderOverview() {
    const r = state.runtime;
    const cards = [];
    cards.push('<div class="card"><div class="card-title">Python Environment ' +
      (r.pythonBin && r.isRealVenv ? pill('Ready', 'ok') : pill('Needs Setup', 'warn')) +
      '</div><div class="muted">' + (r.pythonBin || 'No interpreter configured') + (r.pythonVersion ? ' &middot; ' + r.pythonVersion : '') + '</div></div>');
    cards.push('<div class="card"><div class="card-title">' + state.runtime.bridgePackageName + ' ' +
      (r.bridgeInstalled ? pill('Installed', 'ok') : pill('Missing', 'warn')) + '</div></div>');
    cards.push('<div class="card"><div class="card-title">Node.js Environment ' + pill('Ready', 'ok') +
      '</div><div class="muted">Node ' + (r.nodeVersion || 'unknown') + ' (bundled with the extension host)</div></div>');
    cards.push('<div class="card"><div class="card-title">Active Sessions</div><div class="muted">' +
      r.sidecarSessions.length + ' sidecar session(s), ' + r.duckDbSessions.length + ' DuckDB session(s)</div></div>');
    document.getElementById('overviewCards').innerHTML = cards.join('');
  }

  function renderRuntime() {
    const r = state.runtime;
    document.getElementById('venvPathInput').value = r.configuredVenvPath || '';
    document.getElementById('pyStatusPill').innerHTML = r.pythonBin
      ? (r.isRealVenv ? pill('Ready', 'ok') : pill('Not a venv', 'err'))
      : pill('Not found', 'warn');
    document.getElementById('pyVersionLine').textContent = r.pythonBin
      ? (r.pythonBin + (r.pythonVersion ? ' — ' + r.pythonVersion : ' — not runnable'))
      : 'No venv auto-detected. Use "Create venv here" or set a path above.';
    const bridgePillEl = document.getElementById('bridgeStatusPill');
    bridgePillEl.className = 'pill ' + (r.bridgeInstalled ? 'ok' : 'warn');
    bridgePillEl.textContent = r.bridgePackageName + (r.bridgeInstalled ? ' installed' : ' not installed');

    document.getElementById('nodeVersionLine').textContent = r.nodeVersion
      ? ('Node ' + r.nodeVersion + ' (bundled with the extension host — no separate install needed)')
      : 'Node runtime version unavailable.';
    const installBtn = document.getElementById('installBridgeBtn');
    const canInstall = !!(r.pythonBin && r.isRealVenv);
    installBtn.disabled = !canInstall;
    document.getElementById('venvGuardNote').textContent = canInstall
      ? ''
      : 'No virtual environment detected — create one first, or point the path above at an existing .venv.';

    const sessions = [];
    r.sidecarSessions.forEach(s => {
      sessions.push('<tr><td>' + s.notebookId + '</td><td>' + s.kind + '</td><td>' + (s.pids.join(', ') || '—') + '</td><td>' +
        (s.anyBusy ? 'busy' : 'idle') + '</td><td><button class="danger" data-terminate="' + s.notebookId + '">Terminate</button></td></tr>');
    });
    document.getElementById('sessionsArea').innerHTML = sessions.length
      ? '<table><tr><th>Notebook</th><th>Kind</th><th>PID</th><th>State</th><th></th></tr>' + sessions.join('') + '</table>'
      : '<div class="empty-note">No active sidecar sessions.</div>';
    document.querySelectorAll('[data-terminate]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'terminateSession', notebookId: btn.dataset.terminate });
      });
    });
  }

  document.getElementById('browseVenvBtn').addEventListener('click', () => vscode.postMessage({ type: 'browseVenvPath' }));
  document.getElementById('autoDetectBtn').addEventListener('click', () => vscode.postMessage({ type: 'requestData' }));
  document.getElementById('createVenvBtn').addEventListener('click', () => vscode.postMessage({ type: 'createVenv' }));
  document.getElementById('installBridgeBtn').addEventListener('click', () => vscode.postMessage({ type: 'installBridge' }));
  document.getElementById('retestBtn').addEventListener('click', () => vscode.postMessage({ type: 'requestData' }));
  document.getElementById('viewLogsBtn').addEventListener('click', () => vscode.postMessage({ type: 'viewLogs' }));

  // ── Connectors ──────────────────────────────────────────────────────────

  function currentKindInfo() {
    return conn.kinds.find(k => k.kind === conn.currentKind) || { fields: [] };
  }

  function profileLabel(p) {
    const k = conn.kinds.find(k => k.kind === p.kind);
    return p.name + ' (' + (k ? k.label : p.kind) + ')';
  }

  function renderConnectors() {
    const kindSel = document.getElementById('connKindSelect');
    kindSel.innerHTML = '';
    conn.kinds.forEach(k => {
      const o = document.createElement('option');
      o.value = k.kind; o.textContent = k.label;
      kindSel.appendChild(o);
    });

    const profSel = document.getElementById('connProfileSelect');
    const prevId = conn.currentProfileId;
    profSel.innerHTML = '';
    const newOpt = document.createElement('option');
    newOpt.value = ''; newOpt.textContent = '+ New Connector';
    profSel.appendChild(newOpt);
    conn.profiles.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = profileLabel(p);
      profSel.appendChild(o);
    });

    document.getElementById('mirrorToggle').checked = !!state.mirrorEnabled;

    const stillExists = conn.profiles.some(p => p.id === prevId);
    if (!conn.isNewProfile && stillExists) {
      profSel.value = prevId;
      populateConnForm(conn.profiles.find(p => p.id === prevId));
    } else if (conn.profiles.length > 0 && !conn.isNewProfile) {
      profSel.value = conn.profiles[0].id;
      populateConnForm(conn.profiles[0]);
    } else {
      profSel.value = '';
      startNewConnProfile();
    }
  }

  document.getElementById('connProfileSelect').addEventListener('change', e => {
    if (!e.target.value) { startNewConnProfile(); return; }
    const p = conn.profiles.find(p => p.id === e.target.value);
    if (p) populateConnForm(p);
  });
  document.getElementById('connNewBtn').addEventListener('click', () => {
    document.getElementById('connProfileSelect').value = '';
    startNewConnProfile();
  });
  document.getElementById('connKindSelect').addEventListener('change', e => {
    conn.currentKind = e.target.value;
    conn.fieldValues = {};
    (currentKindInfo().fields || []).forEach(f => { if (f.default !== undefined) conn.fieldValues[f.key] = f.default; });
    updateConnKindDesc();
    renderConnFields();
  });
  document.getElementById('mirrorToggle').addEventListener('change', e => {
    vscode.postMessage({ type: 'setMirrorEnabled', enabled: e.target.checked });
  });

  function onConnFieldChange(field) {
    const el = document.getElementById('field_' + field.key);
    conn.fieldValues[field.key] = el.value;
    if (field.type === 'select') renderConnFields();
    else validateConn();
  }

  function onConnBrowseFolder(field) {
    vscode.postMessage({ type: 'browseConnectionField', key: field.key });
  }

  function renderConnFields() {
    const area = document.getElementById('connFieldsArea');
    window.VuraConnForm.renderFields(area, currentKindInfo().fields || [], conn.fieldValues, conn.isNewProfile, onConnFieldChange, onConnBrowseFolder);
    validateConn();
  }

  function validateConn() {
    const name = document.getElementById('connName').value.trim();
    const ok = window.VuraConnForm.validate(
      currentKindInfo().fields || [], conn.fieldValues, conn.isNewProfile,
      document.getElementById('connValidationSummary'), document.getElementById('connSaveBtn'),
      [{ label: 'Connection Name', value: name }]
    );
    if (currentKindInfo().available === false) {
      document.getElementById('connSaveBtn').disabled = true;
      return false;
    }
    return ok;
  }
  document.getElementById('connName').addEventListener('input', validateConn);

  function populateConnForm(p) {
    conn.currentProfileId = p.id;
    conn.lastSelectedProfileId = p.id;
    conn.isNewProfile = false;
    conn.currentKind = p.kind;
    document.getElementById('connName').value = p.name || '';
    document.getElementById('connKindSelect').value = p.kind;
    document.getElementById('connKindSelect').disabled = true;
    conn.fieldValues = {};
    (currentKindInfo().fields || []).forEach(f => {
      if (!f.secret) conn.fieldValues[f.key] = (p.config && p.config[f.key] != null) ? String(p.config[f.key]) : (f.default || '');
    });
    document.getElementById('connTestResult').textContent = '';
    updateConnKindDesc();
    renderConnFields();
  }

  function startNewConnProfile() {
    conn.isNewProfile = true;
    conn.currentKind = conn.kinds[0] ? conn.kinds[0].kind : '';
    conn.currentProfileId = conn.currentKind + '-' + Date.now().toString().slice(-6);
    document.getElementById('connName').value = '';
    document.getElementById('connKindSelect').disabled = false;
    document.getElementById('connKindSelect').value = conn.currentKind;
    conn.fieldValues = {};
    (currentKindInfo().fields || []).forEach(f => { if (f.default !== undefined) conn.fieldValues[f.key] = f.default; });
    document.getElementById('connTestResult').textContent = '';
    updateConnKindDesc();
    renderConnFields();
  }

  function updateConnKindDesc() {
    const k = conn.kinds.find(k => k.kind === conn.currentKind);
    document.getElementById('connKindDesc').textContent = k ? k.description : '';
    const unavailable = !!(k && k.available === false);
    // Every connector kind gets a Test Connection option — even one this host can't
    // probe yet (testConnectorConfig() replies "not supported" rather than the button
    // just not existing, so the user always has a way to find out).
    document.getElementById('connTestBtn').style.display = unavailable ? 'none' : 'inline-block';
    const installBtn = document.getElementById('connInstallExtBtn');
    installBtn.style.display = unavailable ? 'inline-block' : 'none';
    installBtn.dataset.extId = unavailable ? k.installExtensionId : '';
    document.getElementById('connFieldsArea').style.display = unavailable ? 'none' : 'block';
    document.getElementById('connSaveBtn').disabled = unavailable;
    document.getElementById('connDeleteBtn').textContent = conn.isNewProfile ? 'Cancel' : 'Delete';
  }

  document.getElementById('connInstallExtBtn').addEventListener('click', e => {
    const extId = e.target.dataset.extId;
    if (extId) vscode.postMessage({ type: 'installProviderExtension', extensionId: extId });
  });

  document.getElementById('connSaveBtn').addEventListener('click', () => {
    if (!validateConn()) return;
    const name = document.getElementById('connName').value.trim();
    const { config, secret } = window.VuraConnForm.collectConfigAndSecret(currentKindInfo().fields || []);
    vscode.postMessage({ type: 'saveConnection', id: conn.currentProfileId, name, kind: conn.currentKind, config, secret });
    conn.isNewProfile = false;
  });
  function cancelNewConnProfile() {
    const target = conn.profiles.find(p => p.id === conn.lastSelectedProfileId) || conn.profiles[0];
    if (target) {
      document.getElementById('connProfileSelect').value = target.id;
      populateConnForm(target);
    } else {
      document.getElementById('connProfileSelect').value = '';
      startNewConnProfile();
    }
  }

  document.getElementById('connDeleteBtn').addEventListener('click', () => {
    if (conn.isNewProfile) {
      cancelNewConnProfile();
      return;
    }
    if (conn.currentProfileId) {
      vscode.postMessage({ type: 'deleteConnection', id: conn.currentProfileId, kind: conn.currentKind });
    }
  });
  document.getElementById('connTestBtn').addEventListener('click', () => {
    const { config, secret } = window.VuraConnForm.collectConfigAndSecret(currentKindInfo().fields || []);
    document.getElementById('connTestResult').textContent = 'Testing…';
    document.getElementById('connTestResult').style.color = '';
    // A blank secret field on an EXISTING connection means "unchanged", not "no secret" —
    // the host fills it in from the stored secret when id/isNewProfile say this isn't a new one.
    vscode.postMessage({ type: 'testConnection', kind: conn.currentKind, id: conn.currentProfileId, isNewProfile: conn.isNewProfile, config, secret });
  });

  // ── Add-ons ──────────────────────────────────────────────────────────────

  function renderAddons() {
    const providerArea = document.getElementById('providerAddonsArea');
    providerArea.innerHTML = state.addons.map(a => {
      const tagStr = a.tags.map(t => '<span class="pill ok" style="background:transparent;border:1px solid currentColor">' + t + '</span>').join(' ');
      const statusPill = !a.installed
        ? pill('Not installed', 'warn')
        : (!a.registered
          ? pill('Installed — not active yet', 'warn')
          : (a.enabled ? pill('Enabled', 'ok') : pill('Disabled', 'err')));
      return '<div class="card"><div class="card-title">' + a.displayName + ' ' + statusPill + '</div>' +
        '<div class="muted">' + a.description + '</div>' +
        (a.installed && !a.registered
          ? '<div class="muted" style="margin-top:4px">Installed, but hasn’t activated yet — open a .flownb notebook once, or reopen this Hub, and it should register.</div>'
          : '') +
        '<div class="row-flex" style="margin-top:8px">' + tagStr +
        (a.registered
          ? '<button class="secondary" data-toggle-addon="' + a.providerId + '" data-enabled="' + a.enabled + '">' + (a.enabled ? 'Disable' : 'Enable') + '</button>'
          : (a.installed
            ? ''
            : '<button class="secondary" data-install-ext="' + a.extensionId + '">Install</button>')) +
        '</div></div>';
    }).join('');
    providerArea.querySelectorAll('[data-toggle-addon]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'toggleAddonEnabled', providerId: btn.dataset.toggleAddon, enabled: btn.dataset.enabled !== 'true' });
      });
    });
    providerArea.querySelectorAll('[data-install-ext]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'installProviderExtension', extensionId: btn.dataset.installExt });
      });
    });

    const pyArea = document.getElementById('pythonPackagesArea');
    const canInstall = !!(state.runtime.pythonBin && state.runtime.isRealVenv);
    pyArea.innerHTML = state.pythonPackages.map(p => {
      return '<div class="card"><div class="card-title">' + p.name + ' ' + (p.installed ? pill('Installed', 'ok') : pill('Not installed', 'warn')) + '</div>' +
        '<div class="muted">' + p.description + '</div>' +
        '<div class="row-flex" style="margin-top:8px">' +
        '<button data-py-install="' + p.name + '" ' + (canInstall ? '' : 'disabled') + '>' + (p.installed ? 'Reinstall' : 'Install') + '</button>' +
        (p.installed ? '<button class="secondary" data-py-uninstall="' + p.name + '" ' + (canInstall ? '' : 'disabled') + '>Uninstall</button>' : '') +
        '</div></div>';
    }).join('') + (canInstall ? '' : '<div class="muted">No virtual environment detected — set one up under Runtimes first.</div>');
    pyArea.querySelectorAll('[data-py-install]').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type: 'installPythonPackage', name: btn.dataset.pyInstall })));
    pyArea.querySelectorAll('[data-py-uninstall]').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type: 'uninstallPythonPackage', name: btn.dataset.pyUninstall })));
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  function renderStorage() {
    const s = state.storage;
    document.getElementById('storageDirLine').textContent = s.directory;
    document.getElementById('storageUsedLine').textContent = 'Used: ' + s.usedHuman;
    const pct = Math.min(100, (s.usedBytes / (1024 * 1024 * 1024)) * 10); // just a visual indicator, not a hard quota
    document.getElementById('usageBarFill').style.width = pct + '%';
  }
  document.getElementById('purgeBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'purgeTempFiles' });
  });
</script>
</body>
</html>`;
}
