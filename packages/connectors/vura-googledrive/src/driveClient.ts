import { JWT } from 'google-auth-library';
import { ConnectionProfile } from '@vura-data-os/core-sdk';

export interface GoogleDriveProfileConfig {
    serviceAccountEmail?: string; // optional if the secret is a full service-account JSON key
    impersonateUser?: string;     // domain-wide delegation subject, optional
}

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * `secret` is either the full service-account JSON key (preferred — contains
 * client_email + private_key) or, paired with config.serviceAccountEmail, just
 * the raw PEM private key.
 */
export function buildJwtClient(profile: ConnectionProfile<GoogleDriveProfileConfig>, secret: string | undefined): JWT {
    if (!secret) {
        throw new Error(`Google Drive connection "${profile.id}" has no service-account credentials configured.`);
    }

    let clientEmail = profile.config.serviceAccountEmail;
    let privateKey = secret;

    try {
        const parsed = JSON.parse(secret);
        if (parsed.private_key) {
            clientEmail = parsed.client_email || clientEmail;
            privateKey = parsed.private_key;
        }
    } catch {
        // secret wasn't JSON — treat it as the raw PEM private key.
    }

    if (!clientEmail) {
        throw new Error(`Google Drive connection "${profile.id}" is missing "serviceAccountEmail" (or a full JSON key secret).`);
    }

    return new JWT({
        email: clientEmail,
        key: privateKey,
        subject: profile.config.impersonateUser,
        scopes: ['https://www.googleapis.com/auth/drive']
    });
}

export async function driveFetch(client: JWT, url: string, init?: RequestInit & { body?: any }): Promise<Response> {
    const headers = await client.getRequestHeaders();
    const res = await fetch(url, {
        ...init,
        headers: {
            ...headers,
            ...(init?.headers || {})
        } as any
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Google Drive request failed: ${res.status} ${res.statusText}\n${body}`);
    }
    return res;
}

export { DRIVE_BASE, DRIVE_UPLOAD_BASE };
