import { ConnectionProfile } from '@vura-data-os/core-sdk';

export interface OneDriveProfileConfig {
    tenantId: string;
    clientId: string;
    userPrincipalName: string; // the user whose OneDrive is targeted (app-only Files.ReadWrite.All)
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export async function getGraphToken(profile: ConnectionProfile<OneDriveProfileConfig>, secret: string | undefined): Promise<string> {
    const { tenantId, clientId } = profile.config;
    if (!tenantId || !clientId) {
        throw new Error(`OneDrive connection "${profile.id}" is missing "tenantId" or "clientId".`);
    }
    if (!secret) {
        throw new Error(`OneDrive connection "${profile.id}" has no client secret configured.`);
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

function driveRootUrl(profile: ConnectionProfile<OneDriveProfileConfig>): string {
    const upn = profile.config.userPrincipalName;
    if (!upn) {
        throw new Error(`OneDrive connection "${profile.id}" is missing "userPrincipalName".`);
    }
    return `${GRAPH_BASE}/users/${encodeURIComponent(upn)}/drive`;
}

function itemPath(filePath: string): string {
    const clean = filePath.replace(/^\/+/, '');
    return clean ? `:/${clean.split('/').map(encodeURIComponent).join('/')}` : '';
}

export function graphListChildrenUrl(profile: ConnectionProfile<OneDriveProfileConfig>, folderPath: string): string {
    const p = itemPath(folderPath);
    return p ? `${driveRootUrl(profile)}/root${p}:/children` : `${driveRootUrl(profile)}/root/children`;
}

export function graphContentUrl(profile: ConnectionProfile<OneDriveProfileConfig>, filePath: string): string {
    const p = itemPath(filePath);
    return `${driveRootUrl(profile)}/root${p}:/content`;
}

export function graphItemUrl(profile: ConnectionProfile<OneDriveProfileConfig>, filePath: string): string {
    const p = itemPath(filePath);
    return `${driveRootUrl(profile)}/root${p}`;
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
