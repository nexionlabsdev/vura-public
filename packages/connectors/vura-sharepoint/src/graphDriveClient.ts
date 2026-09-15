import { ConnectionProfile } from '@vura-data-os/core-sdk';

export interface SharePointProfileConfig {
    tenantId: string;
    clientId: string;
    siteUrl: string; // e.g. https://contoso.sharepoint.com/sites/TeamSite
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export async function getGraphToken(profile: ConnectionProfile<SharePointProfileConfig>, secret: string | undefined): Promise<string> {
    const { tenantId, clientId } = profile.config;
    if (!tenantId || !clientId) {
        throw new Error(`SharePoint connection "${profile.id}" is missing "tenantId" or "clientId".`);
    }
    if (!secret) {
        throw new Error(`SharePoint connection "${profile.id}" has no client secret configured.`);
    }

    const msal = require('@azure/msal-node');
    const cca = new msal.ConfidentialClientApplication({
        auth: {
            clientId,
            authority: `https://login.microsoftonline.com/${tenantId}`,
            clientSecret: secret
        }
    });
    const response = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default']
    });
    return response.accessToken;
}

/** Splits a SharePoint site URL into the Graph `{hostname}:/{site-path}` pair used for path-based site addressing. */
function siteSegment(siteUrl: string): string {
    const url = new URL(siteUrl);
    const sitePath = url.pathname.replace(/\/+$/, '');
    return `${url.hostname}:${sitePath}`;
}

function itemPath(filePath: string): string {
    const clean = filePath.replace(/^\/+/, '');
    return clean ? `:/${clean.split('/').map(encodeURIComponent).join('/')}` : '';
}

export function graphListChildrenUrl(profile: ConnectionProfile<SharePointProfileConfig>, folderPath: string): string {
    const p = itemPath(folderPath);
    const drivePath = p ? `drive/root${p}:/children` : 'drive/root/children';
    return `${GRAPH_BASE}/sites/${siteSegment(profile.config.siteUrl)}:/${drivePath}`;
}

export function graphContentUrl(profile: ConnectionProfile<SharePointProfileConfig>, filePath: string): string {
    const p = itemPath(filePath);
    return `${GRAPH_BASE}/sites/${siteSegment(profile.config.siteUrl)}:/drive/root${p}:/content`;
}

export function graphItemUrl(profile: ConnectionProfile<SharePointProfileConfig>, filePath: string): string {
    const p = itemPath(filePath);
    return `${GRAPH_BASE}/sites/${siteSegment(profile.config.siteUrl)}:/drive/root${p}`;
}

export async function graphFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(url, {
        ...init,
        headers: {
            ...(init?.headers || {}),
            Authorization: `Bearer ${token}`
        }
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Microsoft Graph request failed: ${res.status} ${res.statusText}\n${body}`);
    }
    return res;
}
