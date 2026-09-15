import { S3Client } from '@aws-sdk/client-s3';
import { ConnectionProfile } from '@vura-data-os/core-sdk';

export interface S3ProfileConfig {
    region: string;
    bucket: string;
    accessKeyId?: string;
    authMode?: 'AccessKey' | 'InstanceProfile';
}

/**
 * Builds an S3Client for a connection profile. `secret` is the secretAccessKey
 * for `AccessKey` auth (config.accessKeyId is the non-secret half); when
 * `authMode` is `InstanceProfile` (or omitted with no accessKeyId), the SDK's
 * default provider chain (env vars, instance/task role, shared config) is used.
 */
export function buildS3Client(profile: ConnectionProfile<S3ProfileConfig>, secret: string | undefined): S3Client {
    const { region, accessKeyId, authMode } = profile.config;
    if (!region) {
        throw new Error(`S3 connection "${profile.id}" is missing required field "region".`);
    }

    if (authMode === 'AccessKey' || (accessKeyId && secret)) {
        if (!accessKeyId || !secret) {
            throw new Error(`S3 connection "${profile.id}" is configured for AccessKey auth but is missing "accessKeyId" or its secret.`);
        }
        return new S3Client({ region, credentials: { accessKeyId, secretAccessKey: secret } });
    }

    return new S3Client({ region });
}

export function resolveBucket(profile: ConnectionProfile<S3ProfileConfig>): string {
    if (!profile.config.bucket) {
        throw new Error(`S3 connection "${profile.id}" is missing required field "bucket".`);
    }
    return profile.config.bucket;
}
