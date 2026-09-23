/**
 * Shared client-side rendering logic for a ConnectionField[]-driven form —
 * used by both the sidebar Connections webview (connectionsConfigViewProvider.ts)
 * and the Environment Hub's Connectors section, so the ~visibility/render/validate
 * logic for a connector's field schema exists in exactly one place.
 *
 * Each host page still owns its own element ids, event wiring, and save/delete/test
 * message posting — this only supplies the pure field-schema -> DOM logic as a
 * small global namespace (`window.VuraConnForm`) injected via a <script> tag before
 * the page's own inline script runs.
 */
export function sharedConnectionFormCss(): string {
    return `
  .vcf-row { margin-bottom: 10px; }
  .vcf-row label { display: block; margin-bottom: 3px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .vcf-row label .req { color: var(--vscode-errorForeground, #f14c4c); margin-left: 2px; }
  .vcf-row input, .vcf-row select {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
    outline: none;
    box-sizing: border-box;
  }
  .vcf-row input:focus, .vcf-row select:focus { border-color: var(--vscode-focusBorder); }
  .vcf-row input.invalid { border-color: var(--vscode-errorForeground, #f14c4c); }
  .vcf-field-row { display: flex; gap: 6px; align-items: center; }
  .vcf-field-row input { flex: 1; min-width: 0; }
  .vcf-field-row button {
    flex-shrink: 0;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 4px 10px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border-radius: 2px;
  }
  .vcf-field-row button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .vcf-help { color: var(--vscode-descriptionForeground); font-size: 0.78em; margin-top: 3px; }
  .vcf-validation-summary {
    display: none;
    font-size: 0.8em;
    color: var(--vscode-errorForeground, #f14c4c);
    margin-top: 10px;
    padding: 6px 8px;
    background: rgba(241, 76, 76, 0.08);
    border: 1px solid rgba(241, 76, 76, 0.25);
    border-radius: 3px;
  }`;
}

export function sharedConnectionFormScript(): string {
    return `
window.VuraConnForm = (function() {
  function isFieldVisible(field, fieldValues) {
    if (!field.showWhen) return true;
    const controllingValue = fieldValues[field.showWhen.field];
    const equals = field.showWhen.equals;
    return Array.isArray(equals) ? equals.includes(controllingValue) : controllingValue === equals;
  }

  function renderFields(area, fields, fieldValues, isNewProfile, onFieldChange, onBrowseFolder) {
    area.innerHTML = '';
    (fields || []).forEach(f => {
      if (!isFieldVisible(f, fieldValues)) return;

      const row = document.createElement('div');
      row.className = 'vcf-row';

      const label = document.createElement('label');
      label.textContent = f.label;
      if (f.required) {
        const req = document.createElement('span');
        req.className = 'req';
        req.textContent = '*';
        label.appendChild(req);
      }
      row.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = f.type === 'password' ? 'password' : (f.type === 'number' ? 'number' : 'text');
        if (f.type === 'folder') input.readOnly = true;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.secret) input.placeholder = input.placeholder ? input.placeholder + ' (leave blank to keep unchanged)' : 'Leave blank to keep unchanged';
      }
      input.id = 'field_' + f.key;
      input.value = fieldValues[f.key] !== undefined ? fieldValues[f.key] : '';

      input.addEventListener('input', () => onFieldChange(f));
      input.addEventListener('change', () => onFieldChange(f));

      if (f.type === 'folder') {
        const fieldRow = document.createElement('div');
        fieldRow.className = 'vcf-field-row';
        fieldRow.appendChild(input);
        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.textContent = 'Browse...';
        browseBtn.addEventListener('click', () => onBrowseFolder && onBrowseFolder(f));
        fieldRow.appendChild(browseBtn);
        row.appendChild(fieldRow);
      } else {
        row.appendChild(input);
      }

      if (f.helpText) {
        const help = document.createElement('div');
        help.className = 'vcf-help';
        help.textContent = f.helpText;
        row.appendChild(help);
      }

      area.appendChild(row);
    });
  }

  function missingRequiredFields(fields, fieldValues, isNewProfile, extraRequired) {
    const missing = [];
    (fields || []).forEach(f => {
      if (!f.required || !isFieldVisible(f, fieldValues)) return;
      const el = document.getElementById('field_' + f.key);
      const val = el ? el.value : (fieldValues[f.key] || '');
      // A secret field left blank on an EXISTING connection means "keep unchanged" —
      // only a brand new connection actually requires a value for it.
      if (f.secret && !isNewProfile) return;
      if (!val) missing.push(f.label);
    });
    if (extraRequired) {
      extraRequired.forEach(r => { if (!r.value) missing.unshift(r.label); });
    }
    return missing;
  }

  function validate(fields, fieldValues, isNewProfile, summaryEl, saveBtnEl, extraRequired) {
    (fields || []).forEach(f => {
      const el = document.getElementById('field_' + f.key);
      if (!el) return;
      const invalid = f.required && isFieldVisible(f, fieldValues) && !el.value && !(f.secret && !isNewProfile);
      el.classList.toggle('invalid', !!invalid);
    });

    const missing = missingRequiredFields(fields, fieldValues, isNewProfile, extraRequired);
    if (summaryEl) {
      if (missing.length > 0) {
        summaryEl.style.display = 'block';
        summaryEl.textContent = 'Missing required field(s): ' + missing.join(', ');
      } else {
        summaryEl.style.display = 'none';
        summaryEl.textContent = '';
      }
    }
    if (saveBtnEl) saveBtnEl.disabled = missing.length > 0;
    return missing.length === 0;
  }

  function collectConfigAndSecret(fields) {
    const config = {};
    let secret;
    (fields || []).forEach(f => {
      const el = document.getElementById('field_' + f.key);
      if (!el) return;
      if (f.secret) {
        if (el.value) secret = el.value;
      } else {
        config[f.key] = el.value;
      }
    });
    return { config, secret };
  }

  return { isFieldVisible, renderFields, validate, collectConfigAndSecret };
})();`;
}
