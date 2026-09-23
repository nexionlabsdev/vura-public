import { shredJson, unshredJson } from '../src/shredder';
import { execSync } from 'child_process';
import * as path from 'path';

class LCG {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }
}

export function generateRandomFixture(seed: number): any {
  const prng = new LCG(seed);

  function genPrimitive(): any {
    const choice = Math.floor(prng.next() * 5);
    switch (choice) {
      case 0: return null;
      case 1: return Math.floor(prng.next() * 2000) - 1000;
      case 2: return Math.round((prng.next() * 200 - 100) * 100) / 100;
      case 3: {
        const strChoices = ["hello", "world", "unicode_🚀", "", "key_with_space "];
        return strChoices[Math.floor(prng.next() * strChoices.length)];
      }
      case 4: return prng.next() < 0.5;
      default: return null;
    }
  }

  function genVal(depth: number): any {
    if (depth > 5 || prng.next() < 0.4) {
      return genPrimitive();
    } else if (prng.next() < 0.7) {
      const length = Math.floor(prng.next() * 4);
      const kindChoices = ["primitive", "object", "empty"];
      const kind = kindChoices[Math.floor(prng.next() * kindChoices.length)];
      if (kind === "empty" || length === 0) {
        return [];
      } else if (kind === "primitive") {
        const arr: any[] = [];
        for (let i = 0; i < length; i++) {
          arr.push(genPrimitive());
        }
        return arr;
      } else {
        // homogeneous object array (uniform fields across objects in array)
        const arr: any[] = [];
        const templateKeys = ["id", "val", "data", "flag"];
        for (let i = 0; i < length; i++) {
          const item: Record<string, any> = {};
          for (const k of templateKeys) {
            item[k] = genPrimitive();
          }
          arr.push(item);
        }
        return arr;
      }
    } else {
      return genDict(depth + 1);
    }
  }

  function genDict(depth: number): Record<string, any> {
    const numKeys = Math.floor(prng.next() * 4) + 1;
    const keys = ["a", "b", "c", "d", "e", "sub_field", "data", "val", "dup_key", "🚀_key"];
    const shuffled = [...keys].sort(() => prng.next() - 0.5);
    const selectedKeys = shuffled.slice(0, numKeys);
    const res: Record<string, any> = {};
    for (const k of selectedKeys) {
      res[k] = genVal(depth + 1);
    }
    return res;
  }

  return genVal(0);
}

function runPythonBatchShredAndUnshred(batch: { name: string; obj: any; jsManifest: any; jsTables: Record<string, any[]> }[]): {
  pyShredResults: { name: string; tables: Record<string, any[]>; manifest: any; tableNames: string[] }[];
  pyUnshredJsShredResults: any[];
} {
  const code = `
import json, sys
from vura.io.shredder import shred_json, unshred_json

input_data = json.loads(sys.stdin.read())
py_shred_results = []
py_unshred_js_shred_results = []

for item in input_data:
    name = item["name"]
    obj = item["obj"]
    tables, manifest, names = shred_json(name, obj)
    py_shred_results.append({"name": name, "tables": tables, "manifest": manifest, "tableNames": names})

    js_manifest = item["jsManifest"]
    js_tables = item["jsTables"]
    unshredded = unshred_json(js_manifest, js_tables)
    py_unshred_js_shred_results.append(unshredded)

print(json.dumps({
    "pyShredResults": py_shred_results,
    "pyUnshredJsShredResults": py_unshred_js_shred_results
}))
`;
  const pyPath = process.env.PYTHON_BIN || 'python3';
  const input = JSON.stringify(batch);
  const out = execSync(`${pyPath} -c '${code.replace(/'/g, "'\"'\"'")}'`, {
    input,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: path.resolve(__dirname, '../../vura-io-py') }
  });
  return JSON.parse(out.toString());
}

describe('Shredder Cross-Language Contract Tests (TS)', () => {
  const NUM_FIXTURES = 100;
  const fixtures: any[] = [];
  const jsShredResults: { name: string; obj: any; jsShred: ReturnType<typeof shredJson> }[] = [];
  let pyBatchResults: ReturnType<typeof runPythonBatchShredAndUnshred>;

  beforeAll(() => {
    const batchInput: { name: string; obj: any; jsManifest: any; jsTables: Record<string, any[]> }[] = [];

    for (let i = 0; i < NUM_FIXTURES; i++) {
      const fixture = generateRandomFixture(1000 + i);
      fixtures.push(fixture);
      const dsName = `ds_${i}`;
      const jsShred = shredJson(dsName, fixture);
      jsShredResults.push({ name: dsName, obj: fixture, jsShred });
      batchInput.push({
        name: dsName,
        obj: fixture,
        jsManifest: jsShred.manifest,
        jsTables: jsShred.tables
      });
    }

    pyBatchResults = runPythonBatchShredAndUnshred(batchInput);
  });

  test(`should match manifest structure and table count across JS and Python for ${NUM_FIXTURES} randomized fixtures`, () => {
    for (let i = 0; i < NUM_FIXTURES; i++) {
      const jsShred = jsShredResults[i].jsShred;
      const pyShred = pyBatchResults.pyShredResults[i];

      expect(Object.keys(jsShred.tables).sort()).toEqual(Object.keys(pyShred.tables).sort());
      expect(jsShred.manifest.dataset_name).toBe(pyShred.manifest.dataset_name);
      expect(jsShred.manifest.root_table).toBe(pyShred.manifest.root_table);
      expect(jsShred.manifest.is_root_array).toBe(pyShred.manifest.is_root_array);
      expect(Object.keys(jsShred.manifest.tables).sort()).toEqual(Object.keys(pyShred.manifest.tables).sort());

      for (const tName of Object.keys(jsShred.manifest.tables)) {
        const jsMeta = jsShred.manifest.tables[tName];
        const pyMeta = pyShred.manifest.tables[tName];

        expect(jsMeta.table_name).toBe(pyMeta.table_name);
        expect(jsMeta.parent_table).toBe(pyMeta.parent_table);
        expect(jsMeta.field_name).toBe(pyMeta.field_name);
        expect(jsMeta.node_type).toBe(pyMeta.node_type);
        expect(jsMeta.field_order).toEqual(pyMeta.field_order);
        expect(jsMeta.children).toEqual(pyMeta.children);

        // Record length check per table
        expect(jsShred.tables[tName].length).toBe(pyShred.tables[tName].length);
      }
    }
  });

  test(`should cross-reconstruct JSON: shred-in-JS -> unshred-in-Py and shred-in-Py -> unshred-in-JS`, () => {
    for (let i = 0; i < NUM_FIXTURES; i++) {
      const fixture = fixtures[i];
      const jsShred = jsShredResults[i].jsShred;
      const pyShred = pyBatchResults.pyShredResults[i];

      // JS -> JS roundtrip
      const jsSelfUnshred = unshredJson(jsShred.manifest, jsShred.tables);
      expect(jsSelfUnshred).toEqual(fixture);

      // JS -> Py cross-unshred
      const pyCrossUnshred = pyBatchResults.pyUnshredJsShredResults[i];
      expect(pyCrossUnshred).toEqual(fixture);

      // Py -> JS cross-unshred
      const jsCrossUnshred = unshredJson(pyShred.manifest, pyShred.tables);
      expect(jsCrossUnshred).toEqual(fixture);
    }
  });
});
