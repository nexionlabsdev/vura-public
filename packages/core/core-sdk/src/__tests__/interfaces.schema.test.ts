import { NormalizedSchema } from '../interfaces';

describe('NormalizedSchema shape', () => {
    it('accepts a well-formed schema with an entity, a field, and no relationships', () => {
        const sample: NormalizedSchema = {
            entities: [
                {
                    name: 'accounts',
                    fields: [
                        { name: 'accountid', type: 'guid', nullable: false },
                        { name: 'name', type: 'string', nullable: true }
                    ],
                    relationships: [],
                    inferred: false
                }
            ]
        };

        expect(sample.entities).toHaveLength(1);
        expect(sample.entities[0].fields[0].type).toBe('guid');
        expect(sample.entities[0].fields[1].nullable).toBe(true);
        expect(sample.entities[0].relationships).toEqual([]);
        expect(sample.entities[0].inferred).toBe(false);
    });

    it('accepts a foreign-key relationship', () => {
        const sample: NormalizedSchema = {
            entities: [
                {
                    name: 'contacts',
                    fields: [{ name: 'parentcustomerid', type: 'reference', nullable: true }],
                    relationships: [
                        {
                            sourceField: 'parentcustomerid',
                            targetEntity: 'accounts',
                            targetField: 'accountid',
                            kind: 'foreign-key'
                        }
                    ],
                    inferred: false
                }
            ]
        };

        expect(sample.entities[0].relationships[0].kind).toBe('foreign-key');
    });
});
