import json
import os
import sys
import subprocess
import unittest
from vura.io.shredder import shred_json, unshred_json

class LCG:
    def __init__(self, seed):
        self.seed = seed

    def next(self):
        self.seed = (self.seed * 1664525 + 1013904223) % 4294967296
        return self.seed / 4294967296

def generate_random_fixture(seed):
    prng = LCG(seed)

    def gen_primitive():
        choice = int(prng.next() * 5)
        if choice == 0:
            return None
        elif choice == 1:
            return int(prng.next() * 2000) - 1000
        elif choice == 2:
            return round((prng.next() * 200 - 100) * 100) / 100
        elif choice == 3:
            str_choices = ["hello", "world", "unicode_🚀", "", "key_with_space "]
            return str_choices[int(prng.next() * len(str_choices))]
        else:
            return prng.next() < 0.5

    def gen_val(depth):
        if depth > 5 or prng.next() < 0.4:
            return gen_primitive()
        elif prng.next() < 0.7:
            length = int(prng.next() * 4)
            kind_choices = ["primitive", "object", "empty"]
            kind = kind_choices[int(prng.next() * len(kind_choices))]
            if kind == "empty" or length == 0:
                return []
            elif kind == "primitive":
                return [gen_primitive() for _ in range(length)]
            else:
                template_keys = ["id", "val", "data", "flag"]
                arr = []
                for _ in range(length):
                    item = {k: gen_primitive() for k in template_keys}
                    arr.append(item)
                return arr
        else:
            return gen_dict(depth + 1)

    def gen_dict(depth):
        num_keys = int(prng.next() * 4) + 1
        keys = ["a", "b", "c", "d", "e", "sub_field", "data", "val", "dup_key", "🚀_key"]
        # sort key sample deterministically with PRNG
        shuffled = sorted(keys, key=lambda _: prng.next())
        selected_keys = shuffled[:num_keys]
        return {k: gen_val(depth + 1) for k in selected_keys}

    return gen_val(0)


def run_node_batch_shred_and_unshred(batch):
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../"))
    vura_io_dist = os.path.join(root_dir, "packages/core/vura-io/dist/shredder.js")

    js_code = f"""
const {{ shredJson, unshredJson }} = require('{vura_io_dist}');
const inputData = JSON.parse(process.env.INPUT_DATA);

const jsShredResults = [];
const jsUnshredPyShredResults = [];

for (const item of inputData) {{
    const name = item.name;
    const obj = item.obj;
    const jsShred = shredJson(name, obj);
    jsShredResults.push({{ name, tables: jsShred.tables, manifest: jsShred.manifest, tableNames: jsShred.tableNames }});

    const pyManifest = item.pyManifest;
    const pyTables = item.pyTables;
    const unshredded = unshredJson(pyManifest, pyTables);
    jsUnshredPyShredResults.push(unshredded);
}}

console.log(JSON.stringify({{ jsShredResults, jsUnshredPyShredResults }}));
"""
    input_str = json.dumps(batch)
    cmd = ["node", "-e", js_code]
    env = {**os.environ, "INPUT_DATA": input_str}
    res = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
    return json.loads(res.stdout)


class TestShredderContract(unittest.TestCase):
    def test_shredder_cross_language_contract(self):
        num_fixtures = 100
        fixtures = [generate_random_fixture(1000 + i) for i in range(num_fixtures)]
        batch_input = []
        py_shred_results = []

        for i, fixture in enumerate(fixtures):
            ds_name = f"ds_{i}"
            tables, manifest, table_names = shred_json(ds_name, fixture)
            py_shred = {"name": ds_name, "tables": tables, "manifest": manifest, "tableNames": table_names}
            py_shred_results.append(py_shred)
            batch_input.append({
                "name": ds_name,
                "obj": fixture,
                "pyManifest": manifest,
                "pyTables": tables
            })

        node_batch_res = run_node_batch_shred_and_unshred(batch_input)
        js_shred_results = node_batch_res["jsShredResults"]
        js_unshred_py_shred_results = node_batch_res["jsUnshredPyShredResults"]

        for i in range(num_fixtures):
            fixture = fixtures[i]
            py_shred = py_shred_results[i]
            js_shred = js_shred_results[i]

            self.assertEqual(sorted(py_shred["tables"].keys()), sorted(js_shred["tables"].keys()))
            self.assertEqual(py_shred["manifest"]["dataset_name"], js_shred["manifest"]["dataset_name"])
            self.assertEqual(py_shred["manifest"]["root_table"], js_shred["manifest"]["root_table"])
            self.assertEqual(py_shred["manifest"]["is_root_array"], js_shred["manifest"]["is_root_array"])
            self.assertEqual(sorted(py_shred["manifest"]["tables"].keys()), sorted(js_shred["manifest"]["tables"].keys()))

            for t_name in py_shred["manifest"]["tables"].keys():
                py_meta = py_shred["manifest"]["tables"][t_name]
                js_meta = js_shred["manifest"]["tables"][t_name]

                self.assertEqual(py_meta["table_name"], js_meta["table_name"])
                self.assertEqual(py_meta["parent_table"], js_meta["parent_table"])
                self.assertEqual(py_meta["field_name"], js_meta["field_name"])
                self.assertEqual(py_meta["node_type"], js_meta["node_type"])
                self.assertEqual(py_meta["field_order"], js_meta["field_order"])
                self.assertEqual(py_meta["children"], js_meta["children"])
                self.assertEqual(len(py_shred["tables"][t_name]), len(js_shred["tables"][t_name]))

            # Py -> Py roundtrip
            self.assertEqual(unshred_json(py_shred["manifest"], py_shred["tables"]), fixture)

            # Py -> JS cross-unshred
            self.assertEqual(js_unshred_py_shred_results[i], fixture)

            # JS -> Py cross-unshred
            self.assertEqual(unshred_json(js_shred["manifest"], js_shred["tables"]), fixture)
