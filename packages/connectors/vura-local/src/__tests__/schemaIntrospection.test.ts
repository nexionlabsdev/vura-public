import { IVuraEnvironment } from '@vura-data-os/core-sdk';
import { describeSchemaFromSample, groupSampleCandidates, MAX_FILES_PER_EXTENSION } from '../schemaIntrospection';

describe('describeSchemaFromSample', () => {
    function fakeEnv(rows: any[]): IVuraEnvironment {
        return {
            runLocalQuery: jest.fn().mockResolvedValue(rows)
        } as unknown as IVuraEnvironment;
    }

    it('maps a DESCRIBE result into a NormalizedEntity flagged as inferred', async () => {
        const env = fakeEnv([
            { column_name: 'id', column_type: 'BIGINT', null: 'NO' },
            { column_name: 'active', column_type: 'BOOLEAN', null: 'YES' }
        ]);

        const entity = await describeSchemaFromSample(env, Buffer.from('{}'), 'json', 'data/sample.json');

        expect(entity.name).toBe('data/sample.json');
        expect(entity.inferred).toBe(true);
        expect(entity.relationships).toEqual([]);
        expect(entity.fields).toEqual([
            { name: 'id', type: 'number', nullable: false },
            { name: 'active', type: 'boolean', nullable: true }
        ]);
    });
});

describe('groupSampleCandidates', () => {
    it('caps the number of sampled files per extension', () => {
        const paths = Array.from({ length: MAX_FILES_PER_EXTENSION + 3 }, (_, i) => `file${i}.parquet`);
        const candidates = groupSampleCandidates(paths);
        expect(candidates).toHaveLength(MAX_FILES_PER_EXTENSION);
        expect(candidates.every(c => c.format === 'parquet')).toBe(true);
    });

    it('ignores unrecognized extensions', () => {
        const candidates = groupSampleCandidates(['a.csv', 'b.xlsx', 'c.parquet']);
        expect(candidates.map(c => c.path).sort()).toEqual(['a.csv', 'c.parquet']);
    });
});
