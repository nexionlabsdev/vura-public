import os
import json
import tempfile
import unittest
import pyarrow as pa
from vura.io.data import DataManager

class TestPartitioningContractPy(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="vura-py-test-part-")
        os.environ["VURA_STORAGE_PATH"] = self.tmp_dir
        os.environ["VURA_PARTITION_THRESHOLD_ROWS"] = "10"
        self.data_mgr = DataManager(self.tmp_dir)

    def tearDown(self):
        if "VURA_PARTITION_THRESHOLD_ROWS" in os.environ:
            del os.environ["VURA_PARTITION_THRESHOLD_ROWS"]
        import shutil
        if os.path.exists(self.tmp_dir):
            shutil.rmtree(self.tmp_dir)

    def test_boundary_below_threshold(self):
        rows = [{"id": i, "name": f"row_{i}"} for i in range(9)]
        self.data_mgr.put("test_tbl", rows)

        arrow_file = os.path.join(self.tmp_dir, "test_tbl.arrow")
        manifest_file = os.path.join(self.tmp_dir, "test_tbl", "manifest.json")

        self.assertTrue(os.path.exists(arrow_file))
        self.assertFalse(os.path.exists(manifest_file))
        self.assertEqual(self.data_mgr.count("test_tbl"), 9)

    def test_boundary_exact_threshold(self):
        rows = [{"id": i, "name": f"row_{i}"} for i in range(10)]
        self.data_mgr.put("test_tbl", rows)

        manifest_file = os.path.join(self.tmp_dir, "test_tbl", "manifest.json")
        part0 = os.path.join(self.tmp_dir, "test_tbl", "part-0000.parquet")
        arrow_file = os.path.join(self.tmp_dir, "test_tbl.arrow")

        self.assertTrue(os.path.exists(manifest_file))
        self.assertTrue(os.path.exists(part0))
        self.assertFalse(os.path.exists(arrow_file))

        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["rowCount"], 10)
        self.assertEqual(len(manifest["parts"]), 1)
        self.assertEqual(self.data_mgr.count("test_tbl"), 10)

    def test_migration_on_append(self):
        rows = [{"id": i, "val": f"init_{i}"} for i in range(6)]
        self.data_mgr.put("mig_tbl", rows)

        arrow_file = os.path.join(self.tmp_dir, "mig_tbl.arrow")
        self.assertTrue(os.path.exists(arrow_file))

        app_rows = [{"id": i + 6, "val": f"app_{i}"} for i in range(5)]
        self.data_mgr.append("mig_tbl", app_rows)
        self.data_mgr.flush("mig_tbl")

        self.assertFalse(os.path.exists(arrow_file))

        manifest_file = os.path.join(self.tmp_dir, "mig_tbl", "manifest.json")
        part0 = os.path.join(self.tmp_dir, "mig_tbl", "part-0000.parquet")
        part1 = os.path.join(self.tmp_dir, "mig_tbl", "part-0001.parquet")

        self.assertTrue(os.path.exists(manifest_file))
        self.assertTrue(os.path.exists(part0))
        self.assertTrue(os.path.exists(part1))

        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["rowCount"], 11)
        self.assertEqual(len(manifest["parts"]), 2)

    def test_stream_arrow_format(self):
        rows = [{"id": i, "score": i * 10} for i in range(15)]
        self.data_mgr.put("stream_tbl", rows)

        batches = list(self.data_mgr.stream("stream_tbl", batch_size=5, format="arrow"))
        self.assertTrue(len(batches) > 0)
        self.assertIsInstance(batches[0], pa.RecordBatch)

if __name__ == "__main__":
    unittest.main()
