import io
import tempfile
import tarfile
import unittest
from pathlib import Path

from checkpoint_bundle import inspect_checkpoint


class CheckpointBundleTests(unittest.TestCase):
    def test_archive_extraction_matches_directory_identity(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source"
            source.mkdir()
            (source / "config.json").write_text("{}")
            (source / "weights.bin").write_bytes(b"fixture-only-weights")
            archive = root / "model.tar.gz"
            with tarfile.open(archive, "w:gz") as output:
                for path in sorted(source.iterdir()):
                    output.add(path, arcname=path.name)
            destination, archived = inspect_checkpoint(archive, root / "private" / "model")
            self.assertEqual(archived, inspect_checkpoint(source)[1])
            self.assertEqual((destination / "weights.bin").read_bytes(), b"fixture-only-weights")

    def test_tar_links_and_traversal_cannot_escape_private_extraction(self):
        for kind in ("symlink", "hardlink", "traversal"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                root = Path(root)
                archive = root / "model.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    member = tarfile.TarInfo("../escape" if kind == "traversal" else "link")
                    if kind == "traversal":
                        member.size = 1
                    else:
                        member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                        member.linkname = "/etc/passwd"
                    output.addfile(member, io.BytesIO(b"x") if kind == "traversal" else None)
                with self.assertRaises(ValueError):
                    inspect_checkpoint(archive, root / "private")
                self.assertFalse((root / "escape").exists())

    def test_directory_links_and_empty_bundles_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            with self.assertRaises(ValueError):
                inspect_checkpoint(root)
            (root / "link").symlink_to("/etc/passwd")
            with self.assertRaises(OSError):
                inspect_checkpoint(root)


if __name__ == "__main__":
    unittest.main()
