import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DatasetConversion(unittest.TestCase):
    def test_real_v3_converter_validates_output_and_propagates_missing_data(self):
        import pyarrow as pa
        import pyarrow.parquet as pq

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "v3"
            (source / "meta/episodes/chunk-000").mkdir(parents=True)
            (source / "data/chunk-000").mkdir(parents=True)
            (source / "meta/info.json").write_text(json.dumps({
                "codebase_version": "v3.0", "total_episodes": 1, "chunks_size": 1000,
                "features": {"action": {"dtype": "float32"}},
            }))
            pq.write_table(pa.Table.from_pylist([{
                "episode_index": 0, "data/chunk_index": 0, "data/file_index": 0,
                "dataset_from_index": 0, "dataset_to_index": 2, "length": 2, "tasks": ["reach"],
            }]), source / "meta/episodes/chunk-000/file-000.parquet")
            pq.write_table(pa.Table.from_pylist([{"action": [0.0]}, {"action": [0.1]}]),
                           source / "data/chunk-000/file-000.parquet")
            command = [sys.executable, str(Path(__file__).with_name("hf_import.py")), "--source-dir", str(source)]
            good = subprocess.run([*command, "--output-dir", str(root / "good")], capture_output=True, text=True)
            self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
            self.assertEqual(json.loads((root / "good/dataset-manifest.json").read_text())["episodeCount"], 1)
            self.assertEqual(json.loads((source / "meta/info.json").read_text())["codebase_version"], "v3.0")
            (source / "data/chunk-000/file-000.parquet").unlink()
            bad = subprocess.run([*command, "--output-dir", str(root / "bad")], capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0, "converter warnings must not become successful publication")
            self.assertFalse((root / "bad/dataset-manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
