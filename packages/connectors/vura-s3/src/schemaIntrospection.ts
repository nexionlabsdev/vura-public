import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IVuraEnvironment, NormalizedEntity, NormalizedField } from '@vura-data-os/core-sdk';

/** Schema-on-read: no native schema API exists for flat files, so a bounded
 *  sample of rows is read and DuckDB's own type inference is reused (via
 *  env.runLocalQuery's DESCRIBE) rather than writing new parsing/inference
 *  code - mirrors fileFormats.ts's loadBufferIntoTable's temp-file + DuckDB
 *  read_*_auto pattern exactly, but DESCRIBEs a bounded sample instead of
 *  CREATE TABLE-ing the whole file. */
export const SAMPLE_ROW_LIMIT = 100;
export const MAX_FILES_PER_EXTENSION = 5;

function mapDuckDbType(columnType: string): NormalizedField['type'] {
    const t = columnType.toUpperCase();
    if (t.includes('VARCHAR') || t.includes('TEXT') || t.includes('CHAR')) return 'string';
    if (t.includes('BOOLEAN')) return 'boolean';
    if (t.includes('TIMESTAMP') || t.includes('DATE') || t.includes('TIME')) return 'datetime';
    if (t.includes('UUID')) return 'guid';
    if (
        t.includes('BIGINT') || t.includes('INTEGER') || t.includes('DOUBLE') ||
        t.includes('DECIMAL') || t.includes('HUGEINT') || t.includes('FLOAT') || t.includes('SMALLINT')
    ) {
        return 'number';
    }
    return 'unknown';
}

export async function describeSchemaFromSample(
    env: IVuraEnvironment,
    buffer: Buffer,
    format: 'csv' | 'json' | 'parquet',
    sourceName: string
): Promise<NormalizedEntity> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vura-schema-sample-'));
    try {
        const filePath = path.join(tmpDir, `data.${format}`);
        await fs.promises.writeFile(filePath, buffer);
        const safePath = filePath.replace(/\\/g, '/');

        const readExpr = format === 'json' ? `read_json_auto('${safePath}')`
            : format === 'parquet' ? `read_parquet('${safePath}')`
            : `read_csv_auto('${safePath}')`;

        const rows = await env.runLocalQuery(`DESCRIBE SELECT * FROM ${readExpr} LIMIT ${SAMPLE_ROW_LIMIT}`);
        const fields: NormalizedField[] = rows.map((r: any) => ({
            name: r.column_name,
            type: mapDuckDbType(String(r.column_type)),
            nullable: r.null !== 'NO'
        }));

        return { name: sourceName, fields, relationships: [], inferred: true };
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

const SAMPLED_EXTENSIONS: Record<string, 'csv' | 'json' | 'parquet'> = {
    '.csv': 'csv',
    '.json': 'json',
    '.parquet': 'parquet'
};

export function groupSampleCandidates(paths: string[]): { path: string; format: 'csv' | 'json' | 'parquet' }[] {
    const byExtension = new Map<string, string[]>();
    for (const p of paths) {
        const ext = path.extname(p).toLowerCase();
        const format = SAMPLED_EXTENSIONS[ext];
        if (!format) continue;
        const bucket = byExtension.get(ext) || [];
        bucket.push(p);
        byExtension.set(ext, bucket);
    }

    const candidates: { path: string; format: 'csv' | 'json' | 'parquet' }[] = [];
    for (const [ext, filePaths] of byExtension) {
        const format = SAMPLED_EXTENSIONS[ext];
        for (const p of filePaths.slice(0, MAX_FILES_PER_EXTENSION)) {
            candidates.push({ path: p, format });
        }
    }
    return candidates;
}
