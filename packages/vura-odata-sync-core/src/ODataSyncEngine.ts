import { v4 as uuidv4 } from 'uuid';
import { FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';

export interface AlternateKey {
    logicalName: string;
    keyAttributes: string[];
}

export interface EntityMetadata {
    primaryIdAttribute: string;
    entitySetName: string;
    alternateKeys: AlternateKey[];
    attributes: string[];
}

export interface SyncOptions {
    baseUrl: string;
    getToken: () => Promise<string>;
    source: string;
    target: string;
    mode?: 'upsert' | 'insert';
    batchSize?: number;
    key?: string;
    apiPathPrefix?: string;
    fetchMetadata?: (baseUrl: string, targetEntity: string, token: string) => Promise<EntityMetadata>;
    env: IVuraEnvironment;
    logger: ICellLogger;
}

export interface BatchError {
    recordIndex: number;
    recordKey: string;
    error: string;
}

export interface SyncResult {
    totalRecords: number;
    totalSuccess: number;
    errors: BatchError[];
    skippedColumns: string[];
    keyType: 'primary' | 'alternate';
    resolvedKey: string;
}

export class ODataSyncEngine {
    public static async sync(options: SyncOptions): Promise<SyncResult> {
        const {
            baseUrl,
            getToken,
            source,
            target,
            mode = 'upsert',
            batchSize = 1000,
            key,
            apiPathPrefix = '',
            fetchMetadata,
            env,
            logger
        } = options;

        const token = await getToken();

        // 1. Fetch metadata
        await logger.logText(`Fetching OData metadata for target "${target}"…`);
        let metadata: EntityMetadata;

        if (fetchMetadata) {
            metadata = await fetchMetadata(baseUrl, target, token);
        } else {
            metadata = await ODataSyncEngine.defaultFetchMetadata(baseUrl, apiPathPrefix, target, token);
        }

        // 2. Resolve Key
        const resolvedKey = key || metadata.primaryIdAttribute;
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
                const requestedParts = resolvedKey.split(',').map(s => s.trim().toLowerCase());
                const matchingMultiKey = metadata.alternateKeys.find(
                    ak => ak.keyAttributes.length === requestedParts.length &&
                        requestedParts.every(rp => ak.keyAttributes.map(a => a.toLowerCase()).includes(rp))
                );
                if (matchingMultiKey) {
                    keyType = 'alternate';
                } else if (metadata.attributes.some(a => a.toLowerCase() === resolvedKey.toLowerCase())) {
                    keyType = 'alternate';
                } else {
                    const availableKeys = [
                        `Primary: ${metadata.primaryIdAttribute}`,
                        ...metadata.alternateKeys.map(ak => `Alternate: ${ak.keyAttributes.join(', ')}`)
                    ].join('\n  • ');
                    throw new Error(
                        `Key "${resolvedKey}" is neither the primary key nor a recognized alternate key for "${target}".\n\nAvailable keys:\n  • ${availableKeys}`
                    );
                }
            }
        }

        await logger.logText(`Key resolved: "${resolvedKey}" (${keyType} key)`);

        // 3. Read records from local analytics engine
        await logger.logText(`Reading records from local table "${source}"…`);
        let records: any[];
        try {
            records = await env.runLocalQuery(`SELECT * FROM "${source}"`);
        } catch (err: any) {
            throw new Error(`Failed to read from local table "${source}": ${err.message}`);
        }

        if (!records || records.length === 0) {
            throw new Error(`Local table "${source}" is empty. Nothing to sync.`);
        }

        // 4. Column validation
        const localColumns = Object.keys(records[0]);
        const validColumns: string[] = [];
        const skippedColumns: string[] = [];

        if (metadata.attributes.length > 0) {
            const attrLower = new Set(metadata.attributes.map(a => a.toLowerCase()));
            for (const col of localColumns) {
                if (attrLower.has(col.toLowerCase())) {
                    validColumns.push(col);
                } else {
                    skippedColumns.push(col);
                }
            }
        } else {
            validColumns.push(...localColumns);
        }

        if (skippedColumns.length > 0) {
            await logger.logText(`⚠ Skipping ${skippedColumns.length} unmapped column(s): ${skippedColumns.join(', ')}`);
        }

        const keyParts = resolvedKey.split(',').map(s => s.trim());
        for (const kp of keyParts) {
            if (!localColumns.some(c => c.toLowerCase() === kp.toLowerCase())) {
                throw new Error(
                    `Key column "${kp}" not found in local table "${source}". Available columns: ${localColumns.join(', ')}`
                );
            }
        }

        await logger.logText(
            `Syncing ${records.length} record(s) → "${target}" (${metadata.entitySetName}) in batches of ${batchSize}…`
        );

        // 5. Send batches
        const chunks: any[][] = [];
        for (let i = 0; i < records.length; i += batchSize) {
            chunks.push(records.slice(i, i + batchSize));
        }

        let totalSuccess = 0;
        let allErrors: BatchError[] = [];

        const endpointPrefix = apiPathPrefix ? (apiPathPrefix.startsWith('/') ? apiPathPrefix : `/${apiPathPrefix}`) : '';
        const fullEntityUrl = `${baseUrl.replace(/\/+$/, '')}${endpointPrefix}`;

        for (let ci = 0; ci < chunks.length; ci++) {
            await logger.logText(`Sending batch ${ci + 1}/${chunks.length} (${chunks[ci].length} records)…`);

            const { successCount, batchErrors } = await ODataSyncEngine.sendBatchRequest({
                endpointUrl: fullEntityUrl,
                entitySetName: metadata.entitySetName,
                keyColumns: keyParts,
                keyType,
                mode,
                records: chunks[ci],
                validColumns,
                token,
                globalOffset: ci * batchSize
            });

            totalSuccess += successCount;
            allErrors = allErrors.concat(batchErrors);
        }

        const result: SyncResult = {
            totalRecords: records.length,
            totalSuccess,
            errors: allErrors,
            skippedColumns,
            keyType,
            resolvedKey
        };

        const resultHtml = ODataSyncEngine.buildResultHtml(result);
        await logger.replaceOutput(resultHtml);

        return result;
    }

    private static async defaultFetchMetadata(
        baseUrl: string,
        apiPathPrefix: string,
        targetEntity: string,
        token: string
    ): Promise<EntityMetadata> {
        const prefix = apiPathPrefix ? (apiPathPrefix.startsWith('/') ? apiPathPrefix : `/${apiPathPrefix}`) : '';
        const url = `${baseUrl.replace(/\/+$/, '')}${prefix}/${targetEntity}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch metadata from ${url}: ${res.status} ${res.statusText}`);
        }

        const data: any = await res.json();
        const sample = Array.isArray(data.value) && data.value.length > 0 ? data.value[0] : {};
        const attributes = Object.keys(sample);
        const primaryIdAttribute = attributes.find(a => a.toLowerCase() === 'id' || a.toLowerCase().endsWith('id')) || attributes[0] || 'id';

        return {
            primaryIdAttribute,
            entitySetName: targetEntity,
            alternateKeys: [],
            attributes
        };
    }

    public static async sendBatchRequest(params: {
        endpointUrl: string;
        entitySetName: string;
        keyColumns: string[];
        keyType: 'primary' | 'alternate';
        mode: 'upsert' | 'insert';
        records: any[];
        validColumns: string[];
        token: string;
        globalOffset: number;
    }): Promise<{ successCount: number; batchErrors: BatchError[] }> {
        const {
            endpointUrl,
            entitySetName,
            keyColumns,
            keyType,
            mode,
            records,
            validColumns,
            token,
            globalOffset
        } = params;

        const batchId = `batch_${uuidv4()}`;
        const changesetId = `changeset_${uuidv4()}`;

        let payload = `--${batchId}\r\n`;
        payload += `Content-Type: multipart/mixed; boundary=${changesetId}\r\n\r\n`;

        records.forEach((rec, index) => {
            payload += `--${changesetId}\r\n`;
            payload += `Content-Type: application/http\r\n`;
            payload += `Content-Transfer-Encoding: binary\r\n`;
            payload += `Content-ID: ${index + 1}\r\n\r\n`;

            const body: Record<string, any> = {};
            for (const col of validColumns) {
                if (rec[col] !== undefined) {
                    body[col] = rec[col];
                }
            }

            if (mode === 'insert') {
                payload += `POST ${endpointUrl}/${entitySetName} HTTP/1.1\r\n`;
                payload += `Content-Type: application/json; type=entry\r\n\r\n`;
                payload += JSON.stringify(body) + '\r\n';
            } else {
                const keySegment = ODataSyncEngine.buildKeySegment(rec, keyColumns, keyType);
                const patchBody = { ...body };
                if (keyType === 'primary') {
                    for (const kc of keyColumns) {
                        delete patchBody[kc];
                    }
                }

                payload += `PATCH ${endpointUrl}/${entitySetName}(${keySegment}) HTTP/1.1\r\n`;
                payload += `Content-Type: application/json; type=entry\r\n`;
                payload += `If-Match: *\r\n\r\n`;
                payload += JSON.stringify(patchBody) + '\r\n';
            }
        });

        payload += `--${changesetId}--\r\n`;
        payload += `--${batchId}--\r\n`;

        const batchUrl = `${endpointUrl}/$batch`;
        const res = await fetch(batchUrl, {
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
        return ODataSyncEngine.parseBatchResponse(text, records, keyColumns, globalOffset);
    }

    private static buildKeySegment(record: any, keyColumns: string[], keyType: 'primary' | 'alternate'): string {
        if (keyType === 'primary') {
            const val = record[keyColumns[0]];
            return typeof val === 'string' && !val.startsWith("'") ? `'${val}'` : `${val}`;
        } else {
            return keyColumns
                .map(kc => {
                    const val = record[kc];
                    return typeof val === 'string' ? `${kc}='${val}'` : `${kc}=${val}`;
                })
                .join(',');
        }
    }

    public static parseBatchResponse(
        responseText: string,
        originalRecords: any[],
        keyColumns: string[],
        globalOffset: number
    ): { successCount: number; batchErrors: BatchError[] } {
        let successCount = 0;
        const batchErrors: BatchError[] = [];

        const blocks = responseText.split('Content-ID:');
        blocks.shift();

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

    public static buildResultHtml(result: SyncResult): string {
        const hasErrors = result.errors.length > 0;
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
        <span>${ODataSyncEngine.escapeHtml(statusText)}</span>
    </div>
    <div class="sync-meta">
        <span>Total: ${result.totalRecords}</span>
        <span>Key: ${ODataSyncEngine.escapeHtml(result.resolvedKey)} (${result.keyType})</span>
    </div>`;

        if (result.skippedColumns.length > 0) {
            html += `
    <div class="sync-warnings">
        ⚠ Skipped columns not in target: ${ODataSyncEngine.escapeHtml(result.skippedColumns.join(', '))}
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
                    <td>${ODataSyncEngine.escapeHtml(err.recordKey)}</td>
                    <td class="error-cell">${ODataSyncEngine.escapeHtml(err.error)}</td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }

        html += `</div></body></html>`;
        return html;
    }

    private static escapeHtml(unsafe: string): string {
        if (unsafe === undefined || unsafe === null) return '';
        return unsafe.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
