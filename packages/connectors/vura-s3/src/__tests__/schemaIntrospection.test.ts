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
            { column_name: 'name', column_type: 'VARCHAR', null: 'YES' },
            { column_name: 'created_at', column_type: 'TIMESTAMP', null: 'YES' }
        ]);

        const entity = await describeSchemaFromSample(env, Buffer.from('id,name,created_at\n1,a,2024-01-01'), 'csv', 'data/sample.csv');

        expect(entity.name).toBe('data/sample.csv');
        expect(entity.inferred).toBe(true);
        expect(entity.relationships).toEqual([]);
        expect(entity.fields).toEqual([
            { name: 'id', type: 'number', nullable: false },
            { name: 'name', type: 'string', nullable: true },
            { name: 'created_at', type: 'datetime', nullable: true }
        ]);
    });
});

describe('groupSampleCandidates', () => {
    it('caps the number of sampled files per extension', () => {
        const paths = Array.from({ length: MAX_FILES_PER_EXTENSION + 3 }, (_, i) => `file${i}.csv`);
        const candidates = groupSampleCandidates(paths);
        expect(candidates).toHaveLength(MAX_FILES_PER_EXTENSION);
        expect(candidates.every(c => c.format === 'csv')).toBe(true);
    });

    it('ignores unrecognized extensions', () => {
        const candidates = groupSampleCandidates(['a.csv', 'b.txt', 'c.parquet', 'd.json']);
        expect(candidates.map(c => c.path).sort()).toEqual(['a.csv', 'c.parquet', 'd.json']);
    });
});
