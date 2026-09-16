import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_recipe import recipe
from edge_agent import download_pin
from runtime import safe_extract
from virtual_device import LeaseFence, run_probe


class Body(io.BytesIO):
    def iter_chunks(self, chunk_size):
        while chunk := self.read(chunk_size):
            yield chunk


class FakeS3:
    def __init__(self, body, version="v1"):
        self.body, self.version, self.calls = body, version, []
    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        return {"VersionId": self.version, "Body": Body(self.body)}


class EdgeArtifacts(unittest.TestCase):
    def test_staging_downloads_the_exact_version_and_refuses_corruption(self):
        body = b"actual immutable test checkpoint"
        sha = hashlib.sha256(body).hexdigest()
        pin = {"bucket": "archive", "key": "projects/a/model.zip", "versionId": "v1", "bytes": len(body),
               "checksumType": "FULL_OBJECT", "sha256": sha, "checksumSHA256": base64.b64encode(bytes.fromhex(sha)).decode()}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "model"
            s3 = FakeS3(body)
            download_pin(pin, output, s3, "a")
            self.assertEqual(output.read_bytes(), body)
            self.assertEqual(s3.calls[0]["VersionId"], "v1")
            with self.assertRaisesRegex(ValueError, "checksum"):
                download_pin(pin, Path(folder) / "bad", FakeS3(b"wrong"), "a")
            self.assertFalse((Path(folder) / "bad").exists())
            with self.assertRaisesRegex(ValueError, "VersionId"):
                download_pin(pin, Path(folder) / "wrong-version", FakeS3(body, "v2"), "a")

    def test_archive_extraction_cannot_escape_or_create_links(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / "model.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                tar.addfile(entry, io.BytesIO(b"x"))
            with self.assertRaises(ValueError):
                safe_extract(archive, Path(folder) / "model")
            self.assertFalse((Path(folder) / "escape").exists())

    def test_recipe_has_explicit_version_platform_and_safe_environment_configuration(self):
        uri = "s3://bundle/projects/a/" + "a" * 64 + ".zip"
        value = recipe("com.pai.benchmark", "2.3.4", "benchmark", "sb3-ppo", "arm64", uri, "example/runtime@sha256:" + "b" * 64)
        self.assertEqual(value["ComponentVersion"], "2.3.4")
        self.assertEqual(value["Manifests"][0]["Platform"]["architecture"], "aarch64")
        self.assertIn("EDGE_EXECUTION_CONFIG", value["Manifests"][0]["Lifecycle"]["Setenv"])
        self.assertNotIn("{configuration:", value["Manifests"][0]["Lifecycle"]["Run"]["Script"])
        with self.assertRaises(ValueError):
            recipe("x", "", "benchmark", "sb3-ppo", "amd64", uri, "image:latest")


class VirtualCommunication(unittest.TestCase):
    def test_real_loopback_packets_are_communication_only(self):
        result = run_probe(10)
        self.assertEqual(result["type"], "communication")
        self.assertEqual(result["messageCount"], 10)
        self.assertFalse(result["physicalHardwareTested"])
        self.assertGreater(result["results"][0]["avg_ms"], 0)
        self.assertEqual(result["results"][0]["iterations"], 10)

    def test_receiver_rejects_stale_epochs_expiry_and_motion_commands(self):
        fence = LeaseFence()
        fence.install("d", "r", 1, "token1", time.time() * 1000 + 10000)
        message = {"op": "echo", "deviceId": "d", "runId": "r", "epoch": 1, "token": "token1", "sequence": 1, "payload": "data"}
        self.assertEqual(fence.echo(message)["payload"], "data")
        fence.install("d", "r", 2, "token2", time.time() * 1000 + 10000)
        with self.assertRaisesRegex(ValueError, "stale"):
            fence.echo(message)
        message.update(epoch=2, token="token2", op="move")
        with self.assertRaisesRegex(ValueError, "communication-only"):
            fence.echo(message)
        fence.install("d", "r", 3, "token3", time.time() * 1000 - 1)
        message.update(epoch=3, token="token3", op="echo")
        with self.assertRaisesRegex(ValueError, "expired"):
            fence.echo(message)


if __name__ == "__main__":
    unittest.main()
