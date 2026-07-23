import { v4 as uuidv4 } from 'uuid';
import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface SyncDataverseArgs {
    source: string;
    target: string;
    mode: 'upsert' | 'insert';
    batchSize: number;
    key?: string;
}

interface EntityMetadata {
    primaryIdAttribute: string;
    entitySetName: string;
    alternateKeys: AlternateKey[];
    attributes: string[];
}

interface AlternateKey {
    logicalName: string;
    keyAttributes: string[];
}

interface SyncResult {
    totalRecords: number;
    totalSuccess: number;
    errors: BatchError[];
    skippedColumns: string[];
    keyType: 'primary' | 'alternate';
    resolvedKey: string;
}

interface BatchError {
    recordIndex: number;
    recordKey: string;
    error: string;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────────

export async function handleSyncDataverse(
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
): Promise<void> {
    // 1. Parse command arguments
    const args = parseArgs(commandLine);

    // 2. Resolve Dataverse connection from cell metadata
    const connectionId = cell.metadata?.dataverseConnectionId;
    if (!connectionId) {
        throw new Error(
            'No Dataverse connection selected. Use the status bar to pick a Dataverse connection for this cell.'
        );
    }

    const profile = await env.getProfile(connectionId);
    if (!profile) {
        throw new Error(`Connection profile "${connectionId}" not found.`);
    }

    const secret = await env.getProfileSecret(profile.id);
    const orgUrl = `https://${profile.server}`;
    const token = await getToken(profile, secret);

    // 3. Fetch entity metadata
    await logger.logText(`Fetching metadata for entity "${args.target}"…`);
    const metadata = await fetchEntityMetadata(orgUrl, args.target, token);

    // 4. Resolve key
    const resolvedKey = args.key || metadata.primaryIdAttribute;
    let keyType: 'primary' | 'alternate' = 'primary';

    if (resolvedKey.toLowerCase() === metadata.primaryIdAttribute.toLowerCase()) {
        keyType = 'primary';
    } else {
        const matchingAltKey = metadata.alternateKeys.find(
            ak => ak.keyAttributes.length === 1 &&
                ak.keyAttributes[0].toLowerCase() === resolvedKey.toLowerCase()
        );
        if (matchingAltKey) {
            keyType = 'alternate';
        } else {
            // Check multi-attribute alternate keys (comma-separated)
            const requestedParts = resolvedKey.split(',').map(s => s.trim().toLowerCase());
            const matchingMultiKey = metadata.alternateKeys.find(
                ak => ak.keyAttributes.length === requestedParts.length &&
                    requestedParts.every(rp => ak.keyAttributes.map(a => a.toLowerCase()).includes(rp))
            );
            if (matchingMultiKey) {
                keyType = 'alternate';
            } else {
                const availableKeys = [
                    `Primary: ${metadata.primaryIdAttribute}`,
                    ...metadata.alternateKeys.map(ak => `Alternate: ${ak.keyAttributes.join(', ')}`)
                ].join('\n  • ');
                throw new Error(
                    `Key "${resolvedKey}" is neither the primary key nor a recognized alternate key for "${args.target}".\n\nAvailable keys:\n  • ${availableKeys}`
                );
            }
        }
    }

    await logger.logText(`Key resolved: "${resolvedKey}" (${keyType} key)`);

    // 5. Read records from the local analytics engine
    await logger.logText(`Reading records from local table "${args.source}"…`);
    let records: any[];
    try {
        records = await env.runLocalQuery(`SELECT * FROM "${args.source}"`);
    } catch (err: any) {
        throw new Error(`Failed to read from local table "${args.source}": ${err.message}`);
    }

    if (!records || records.length === 0) {
        throw new Error(`Local table "${args.source}" is empty. Nothing to sync.`);
    }

    // 6. Validate columns
    const localColumns = Object.keys(records[0]);
    const dataverseColumnsLower = new Set(metadata.attributes.map(a => a.toLowerCase()));
    const validColumns: string[] = [];
    const skippedColumns: string[] = [];

    for (const col of localColumns) {
        if (dataverseColumnsLower.has(col.toLowerCase())) {
            validColumns.push(col);
        } else {
            skippedColumns.push(col);
        }
    }

    if (skippedColumns.length > 0) {
        await logger.logText(
            `⚠ Skipping ${skippedColumns.length} unmapped column(s): ${skippedColumns.join(', ')}`
        );
    }

    // Ensure the key column(s) exist in local data
    const keyParts = resolvedKey.split(',').map(s => s.trim());
    for (const kp of keyParts) {
        if (!localColumns.some(c => c.toLowerCase() === kp.toLowerCase())) {
            throw new Error(
                `Key column "${kp}" not found in local table "${args.source}". ` +
                `Available columns: ${localColumns.join(', ')}`
            );
        }
    }

    await logger.logText(
        `Syncing ${records.length} record(s) → "${args.target}" (${metadata.entitySetName}) in batches of ${args.batchSize}…`
    );

    // 7. Chunk and send batches
    const chunks: any[][] = [];
    for (let i = 0; i < records.length; i += args.batchSize) {
        chunks.push(records.slice(i, i + args.batchSize));
    }

    let totalSuccess = 0;
    let allErrors: BatchError[] = [];

    for (let ci = 0; ci < chunks.length; ci++) {
        await logger.logText(`Sending batch ${ci + 1}/${chunks.length} (${chunks[ci].length} records)…`);

        const { successCount, batchErrors } = await sendBatchRequest(
            orgUrl,
            metadata.entitySetName,
            keyParts,
            keyType,
            args.mode,
            chunks[ci],
            validColumns,
            token,
            ci * args.batchSize
        );

        totalSuccess += successCount;
        allErrors = allErrors.concat(batchErrors);
    }

    // 8. Render output
    const resultHtml = buildResultHtml({
        totalRecords: records.length,
        totalSuccess,
        errors: allErrors,
        skippedColumns,
        keyType,
        resolvedKey
    });

    await logger.replaceOutput(resultHtml);
}

// ─── Argument Parser ────────────────────────────────────────────────────────────

export function parseArgs(commandLine: string): SyncDataverseArgs {
    // Remove leading "!sync_dataverse" and tokenize
    const stripped = commandLine.replace(/^!sync_dataverse\s*/, '');
    const tokens = stripped.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const args: SyncDataverseArgs = {
        source: '',
        target: '',
        mode: 'upsert',
        batchSize: 1000
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        switch (tok) {
            case '--source':
                args.source = unquote(tokens[++i] || '');
                break;
            case '--target':
                args.target = unquote(tokens[++i] || '');
                break;
            case '--mode':
                const mode = unquote(tokens[++i] || '');
                if (mode !== 'upsert' && mode !== 'insert') {
                    throw new Error(`Invalid mode "${mode}". Supported modes: upsert, insert`);
                }
                args.mode = mode;
                break;
            case '--batch_size':
                args.batchSize = parseInt(unquote(tokens[++i] || ''), 10) || 1000;
                break;
            case '--key':
                args.key = unquote(tokens[++i] || '');
                break;
        }
    }

    if (!args.source) throw new Error('Missing required argument: --source <cell_id/table_name>');
    if (!args.target) throw new Error('Missing required argument: --target <dataverse_entity_logical_name>');

    return args;
}

function unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

// ─── Token Acquisition ──────────────────────────────────────────────────────────

async function getToken(profile: any, secret: string | undefined): Promise<string> {
    const msal = require('@azure/msal-node');
    if (profile.authMode === 'ServicePrincipal') {
        const cca = new msal.ConfidentialClientApplication({
            auth: {
                clientId: profile.clientId,
                authority: `https://login.microsoftonline.com/${profile.tenantId}`,
                clientSecret: secret
            }
        });
        const response = await cca.acquireTokenByClientCredential({
            scopes: [`https://${profile.server}/.default`]
        });
        return response.accessToken;
    }
    throw new Error(`Auth mode "${profile.authMode}" is not supported for Dataverse sync. Use ServicePrincipal.`);
}

// ─── Metadata Fetching ──────────────────────────────────────────────────────────

async function fetchEntityMetadata(orgUrl: string, logicalName: string, token: string): Promise<EntityMetadata> {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
    };

    // 1. Entity definition: PrimaryIdAttribute + EntitySetName
    const defUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')?$select=PrimaryIdAttribute,EntitySetName`;
    const defRes = await fetch(defUrl, { headers });
    if (!defRes.ok) {
        const body = await defRes.text();
        throw new Error(`Failed to fetch entity definition for "${logicalName}": ${defRes.status} ${defRes.statusText}\n${body}`);
    }
    const defData: any = await defRes.json();

    // 2. Alternate keys
    const keysUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Keys?$select=LogicalName,KeyAttributes`;
    const keysRes = await fetch(keysUrl, { headers });
    let alternateKeys: AlternateKey[] = [];
    if (keysRes.ok) {
        const keysData: any = await keysRes.json();
        alternateKeys = (keysData.value || []).map((k: any) => ({
            logicalName: k.LogicalName,
            keyAttributes: k.KeyAttributes || []
        }));
    }

    // 3. Attributes (logical names)
    const attrUrl = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName`;
    const attrRes = await fetch(attrUrl, { headers });
    let attributes: string[] = [];
    if (attrRes.ok) {
        const attrData: any = await attrRes.json();
        attributes = (attrData.value || []).map((a: any) => a.LogicalName);
    }

    return {
        primaryIdAttribute: defData.PrimaryIdAttribute,
        entitySetName: defData.EntitySetName,
        alternateKeys,
        attributes
    };
}

// ─── Batch Request Builder & Sender ─────────────────────────────────────────────

async function sendBatchRequest(
    orgUrl: string,
    entitySetName: string,
    keyColumns: string[],
    keyType: 'primary' | 'alternate',
    mode: 'upsert' | 'insert',
    records: any[],
    validColumns: string[],
    token: string,
    globalOffset: number
): Promise<{ successCount: number; batchErrors: BatchError[] }> {
    const batchId = `batch_${uuidv4()}`;
    const changesetId = `changeset_${uuidv4()}`;

    let payload = `--${batchId}\r\n`;
    payload += `Content-Type: multipart/mixed; boundary=${changesetId}\r\n\r\n`;

    records.forEach((rec, index) => {
        payload += `--${changesetId}\r\n`;
        payload += `Content-Type: application/http\r\n`;
        payload += `Content-Transfer-Encoding: binary\r\n`;
        payload += `Content-ID: ${index + 1}\r\n\r\n`;

        // Build the record body with only valid columns
        const body: Record<string, any> = {};
        for (const col of validColumns) {
            if (rec[col] !== undefined) {
                body[col] = rec[col];
            }
        }

        if (mode === 'insert') {
            payload += `POST ${orgUrl}/api/data/v9.2/${entitySetName} HTTP/1.1\r\n`;
            payload += `Content-Type: application/json; type=entry\r\n\r\n`;
            payload += JSON.stringify(body) + '\r\n';
        } else {
            // upsert → PATCH
            const keySegment = buildKeySegment(rec, keyColumns, keyType);

            // For upsert, remove key columns from the body if it's the primary key
            const patchBody = { ...body };
            if (keyType === 'primary') {
                for (const kc of keyColumns) {
                    delete patchBody[kc];
                }
            }

            payload += `PATCH ${orgUrl}/api/data/v9.2/${entitySetName}(${keySegment}) HTTP/1.1\r\n`;
            payload += `Content-Type: application/json; type=entry\r\n`;
            payload += `If-Match: *\r\n\r\n`;
            payload += JSON.stringify(patchBody) + '\r\n';
        }
    });

    payload += `--${changesetId}--\r\n`;
    payload += `--${batchId}--\r\n`;

    const res = await fetch(`${orgUrl}/api/data/v9.2/$batch`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/mixed; boundary=${batchId}`,
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            'Accept': 'application/json'
        },
        body: payload
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Batch request failed: ${res.status} ${res.statusText}\n${errBody}`);
    }

    const text = await res.text();
    return parseBatchResponse(text, records, keyColumns, globalOffset);
}

function buildKeySegment(record: any, keyColumns: string[], keyType: 'primary' | 'alternate'): string {
    if (keyType === 'primary') {
        // Primary key is always a single GUID
        return record[keyColumns[0]];
    } else {
        // Alternate key: key1='value1',key2='value2'
        return keyColumns
            .map(kc => {
                const val = record[kc];
                if (typeof val === 'string') {
                    return `${kc}='${val}'`;
                }
                return `${kc}=${val}`;
            })
            .join(',');
    }
}

// ─── Batch Response Parser ──────────────────────────────────────────────────────

function parseBatchResponse(
    responseText: string,
    originalRecords: any[],
    keyColumns: string[],
    globalOffset: number
): { successCount: number; batchErrors: BatchError[] } {
    let successCount = 0;
    const batchErrors: BatchError[] = [];

    const blocks = responseText.split('Content-ID:');
    blocks.shift(); // remove preamble

    blocks.forEach(block => {
        const idMatch = block.match(/^\s*(\d+)/);
        if (idMatch) {
            const reqIndex = parseInt(idMatch[1]) - 1;
            const record = originalRecords[reqIndex];

            const statusMatch = block.match(/HTTP\/1\.1\s+(\d+)/);
            if (statusMatch) {
                const statusCode = parseInt(statusMatch[1]);
                if (statusCode >= 200 && statusCode < 300) {
                    successCount++;
                } else {
                    const jsonMatch = block.match(/\{[\s\S]*\}/);
                    let errorMsg = `HTTP ${statusCode}`;
                    if (jsonMatch) {
                        try {
                            const errObj = JSON.parse(jsonMatch[0]);
                            errorMsg = errObj.error?.message || errorMsg;
                        } catch (e) { }
                    }

                    const keyVal = record
                        ? keyColumns.map(kc => `${kc}=${record[kc]}`).join(', ')
                        : 'Unknown';

                    batchErrors.push({
                        recordIndex: globalOffset + reqIndex,
                        recordKey: keyVal,
                        error: errorMsg
                    });
                }
            }
        }
    });

    return { successCount, batchErrors };
}

// ─── Output Rendering ───────────────────────────────────────────────────────────

function buildResultHtml(result: SyncResult): string {
    const hasErrors = result.errors.length > 0;
    const statusColor = hasErrors ? '#ff6b6b' : '#51cf66';
    const statusIcon = hasErrors ? '⚠' : '✓';
    const statusText = hasErrors
        ? `Partial sync: ${result.totalSuccess} succeeded, ${result.errors.length} failed`
        : `Successfully synced ${result.totalSuccess} record(s)`;

    let html = `
<!DOCTYPE html>
<html>
<head>
<style>
    .sync-result {
        font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif);
        font-size: 13px;
        color: var(--vscode-foreground);
        padding: 12px;
    }
    .sync-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 6px;
        margin-bottom: 12px;
        font-weight: 600;
        font-size: 14px;
    }
    .sync-header.success {
        background: rgba(81, 207, 102, 0.12);
        border: 1px solid rgba(81, 207, 102, 0.3);
        color: #51cf66;
    }
    .sync-header.partial {
        background: rgba(255, 107, 107, 0.12);
        border: 1px solid rgba(255, 107, 107, 0.3);
        color: #ff6b6b;
    }
    .sync-meta {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 12px;
        font-size: 12px;
        opacity: 0.8;
    }
    .sync-meta span {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 2px 8px;
        border-radius: 10px;
    }
    .sync-warnings {
        padding: 8px 12px;
        background: rgba(255, 193, 7, 0.1);
        border: 1px solid rgba(255, 193, 7, 0.25);
        border-radius: 4px;
        margin-bottom: 12px;
        font-size: 12px;
        color: #ffc107;
    }
    table {
        border-collapse: collapse;
        width: 100%;
        font-size: 12px;
    }
    th, td {
        border: 1px solid var(--vscode-panel-border, #333);
        padding: 6px 10px;
        text-align: left;
    }
    th {
        background: var(--vscode-editor-inactiveSelectionBackground);
        font-weight: 600;
        position: sticky;
        top: 0;
    }
    tr:nth-child(even) {
        background: var(--vscode-tree-tableOddRowsBackground);
    }
    .error-cell {
        color: #ff6b6b;
    }
</style>
</head>
<body>
<div class="sync-result">
    <div class="sync-header ${hasErrors ? 'partial' : 'success'}">
        <span>${statusIcon}</span>
        <span>${statusText}</span>
    </div>
    <div class="sync-meta">
        <span>Total: ${result.totalRecords}</span>
        <span>Key: ${result.resolvedKey} (${result.keyType})</span>
    </div>`;

    if (result.skippedColumns.length > 0) {
        html += `
    <div class="sync-warnings">
        ⚠ Skipped columns not in Dataverse: ${escapeHtml(result.skippedColumns.join(', '))}
    </div>`;
    }

    if (hasErrors) {
        html += `
    <div style="max-height: 300px; overflow: auto;">
    <table>
        <thead><tr><th>#</th><th>Key</th><th>Error</th></tr></thead>
        <tbody>`;
        for (const err of result.errors) {
            html += `<tr>
                <td>${err.recordIndex + 1}</td>
                <td>${escapeHtml(err.recordKey)}</td>
                <td class="error-cell">${escapeHtml(err.error)}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    html += `</div></body></html>`;
    return html;
}

function escapeHtml(unsafe: string): string {
    if (unsafe === undefined || unsafe === null) return '';
    return unsafe.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
