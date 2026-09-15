import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { IVuraEnvironment, ICellLogger } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';

export async function handleODataWriteback(
    connectionId: string | undefined,
    operation: string,
    sourceTable: string,
    targetEntity: string,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    if (!connectionId || connectionId === 'local') {
        throw new Error("OData Write-Back requires an active Dataverse connection profile in the cell.");
    }

    const activeProfile = await env.getProfile(connectionId);
    if (!activeProfile) {
        throw new Error(`Connection profile ${connectionId} not found.`);
    }

    const secretPayload = await env.getProfileSecret(activeProfile.id);

    // We would need an HTTP client (like axios or node-fetch) to perform actual Dataverse calls
    // Note: For now we'll implement the metadata fetching logic, database extraction, and chunking.

    // Since MSAL node is a dependency, we can use it to get the token.
    // However, making the actual HTTP requests is necessary. We can use native node fetch.

    const orgUrl = `https://${activeProfile.server}`;
    const token = await getToken(activeProfile, secretPayload);
    const pkColumn = await fetchEntityPrimaryKey(orgUrl, targetEntity, token);

    const duckDb = await DuckDbManager.getInstance(env);
    let records: any[] = [];
    
    try {
        records = await duckDb.runQuery(`SELECT * FROM "${sourceTable}"`);
        
        if (records.length > 0 && operation === 'insert') {
            const hasPk = Object.keys(records[0]).some(k => k.toLowerCase() === pkColumn.toLowerCase());
            
            if (!hasPk) {
                try { await duckDb.runQuery(`ALTER TABLE "${sourceTable}" ADD COLUMN "${pkColumn}" VARCHAR`); } catch {}
            }
            
            const crypto = require('crypto');
            let updated = false;
            for (const rec of records) {
                if (!rec[pkColumn]) {
                    rec[pkColumn] = crypto.randomUUID();
                    updated = true;
                }
            }
            
            if (updated) {
                // Save back to duckdb
                const arrow = require('apache-arrow');
                const table = arrow.tableFromJSON(records);
                const chunks = [];
                for await (const chunk of arrow.RecordBatchStreamWriter.writeAll(table)) {
                    chunks.push(chunk);
                }
                await duckDb.saveTableArrowIPC(sourceTable, Buffer.concat(chunks));
            }
        }
    } catch (err: any) {
        throw new Error("Failed to read from DuckDB: " + err.message);
    }

    // 4. Chunk into batch size
    const batchSize = env.getConfig<number>('vura.odataBatchSize', 500) || 500;
    const chunks = [];
    for (let i = 0; i < records.length; i += batchSize) {
        chunks.push(records.slice(i, i + batchSize));
    }

    // 5. Build and send multipart/mixed payload
    let totalSuccess = 0;
    let errors: any[] = [];

    for (const chunk of chunks) {
        const { successCount, batchErrors } = await sendBatchRequest(orgUrl, targetEntity, pkColumn, operation, chunk, token);
        totalSuccess += successCount;
        errors = errors.concat(batchErrors);
    }

    // 6. Output Results
    if (errors.length > 0) {
        const errorHtml = buildErrorTable(errors);
        await logger.logText(`Partial failure. ${totalSuccess} succeeded, ${errors.length} failed.`);
        await logger.logHtml(errorHtml);
    } else {
        await logger.logText(`Successfully pushed ${totalSuccess} records to ${targetEntity}.`);
    }
}

async function getToken(profile: any, secret: string | undefined): Promise<string> {
    // using msal-node or standard REST
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
    throw new Error(`Auth mode ${profile.authMode} not supported for OData Write-Back yet.`);
}

async function fetchEntityPrimaryKey(orgUrl: string, logicalName: string, token: string): Promise<string> {
    const url = `${orgUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${logicalName}')?$select=PrimaryIdAttribute`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
        }
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch entity metadata for ${logicalName}: ${res.statusText}`);
    }
    const data: any = await res.json();
    return data.PrimaryIdAttribute;
}

async function sendBatchRequest(orgUrl: string, entity: string, pkColumn: string, operation: string, records: any[], token: string) {
    const batchId = `batch_${uuidv4()}`;
    const changesetId = `changeset_${uuidv4()}`;

    let payload = `--${batchId}\n`;
    payload += `Content-Type: multipart/mixed; boundary=${changesetId}\n\n`;

    records.forEach((rec, index) => {
        payload += `--${changesetId}\n`;
        payload += `Content-Type: application/http\n`;
        payload += `Content-Transfer-Encoding: binary\n`;
        payload += `Content-ID: ${index + 1}\n\n`;

        if (operation === 'insert') {
            payload += `POST ${orgUrl}/api/data/v9.2/${entity}s HTTP/1.1\n`;
            payload += `Content-Type: application/json; type=entry\n\n`;
            payload += JSON.stringify(rec) + '\n';
        } else if (operation === 'update') {
            const id = rec[pkColumn];
            // Remove pk from body for update? usually safe to leave or exclude
            const body = { ...rec };
            delete body[pkColumn];
            payload += `PATCH ${orgUrl}/api/data/v9.2/${entity}s(${id}) HTTP/1.1\n`;
            payload += `Content-Type: application/json; type=entry\n\n`;
            payload += JSON.stringify(body) + '\n';
        } else if (operation === 'delete') {
            const id = rec[pkColumn];
            payload += `DELETE ${orgUrl}/api/data/v9.2/${entity}s(${id}) HTTP/1.1\n\n`;
        }
    });

    payload += `--${changesetId}--\n`;
    payload += `--${batchId}--\n`;

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
        throw new Error(`Batch request failed: ${res.statusText}`);
    }

    // Parse multipart response
    const text = await res.text();
    return parseBatchResponse(text, records, pkColumn);
}

function parseBatchResponse(responseText: string, originalRecords: any[], pkColumn: string) {
    let successCount = 0;
    const batchErrors: any[] = [];

    // A simple parsing strategy. Each operation response has HTTP/1.1 204 No Content or HTTP/1.1 400 Bad Request
    // We can split by Content-ID or just look for errors
    const blocks = responseText.split('Content-ID:');
    blocks.shift(); // remove first part before the first Content-ID

    blocks.forEach((block, index) => {
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
                    // extract error json
                    const jsonMatch = block.match(/\{[\s\S]*\}/);
                    let errorMsg = `HTTP ${statusCode}`;
                    if (jsonMatch) {
                        try {
                            const errObj = JSON.parse(jsonMatch[0]);
                            errorMsg = errObj.error?.message || errorMsg;
                        } catch(e) {}
                    }
                    batchErrors.push({
                        recordId: record ? record[pkColumn] : 'Unknown',
                        error: errorMsg
                    });
                }
            }
        }
    });

    return { successCount, batchErrors };
}

function buildErrorTable(errors: any[]): string {
    let rows = errors.map(e => `<tr><td>${e.recordId}</td><td>${e.error}</td></tr>`).join('\n');
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                table { border-collapse: collapse; width: 100%; font-family: sans-serif; font-size: 13px; }
                th, td { text-align: left; padding: 8px; border: 1px solid #ddd; }
                th { background-color: #f2f2f2; color: #333; }
                .error-row { color: #d32f2f; }
            </style>
        </head>
        <body>
            <h3>OData Write-Back Errors</h3>
            <table>
                <tr><th>Record ID</th><th>Error Message</th></tr>
                ${rows}
            </table>
        </body>
        </html>
    `;
}
