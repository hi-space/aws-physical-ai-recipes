"""Actual Go upload/restore + CPU PPO recovery, entirely on loopback/local disk."""
import hashlib
import json
import os
from pathlib import Path
import pickle
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import unittest


class RuntimeOptimizerRecovery(unittest.TestCase):
    def test_committed_runtime_restore_recovers_optimizer_and_normalization(self):
        binary = os.environ.get("PAI_RUNTIME_TEST_BINARY")
        self.assertTrue(binary and Path(binary).is_file(), "build/mount the updated static pai-runtime binary")
        import numpy as np
        import torch
        from stable_baselines3 import PPO

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            outputs = {1: base / "attempt-1", 2: base / "attempt-2"}
            for output in outputs.values():
                output.mkdir()
            state = {"attempt": 1, "uploads": {}, "committed": {}, "errors": [], "restores": 0}
            lock = threading.RLock()

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def send(self, status, value=None):
                    data = b"" if value is None else json.dumps(value).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

                def authenticate(self):
                    if self.headers.get("Authorization") != f"Bearer attempt-{state['attempt']}-capability":
                        self.send(410)
                        return False
                    return True

                def do_GET(self):
                    path = unquote(urlsplit(self.path).path)
                    if path.startswith("/objects/"):
                        _empty, _objects, attempt, relative = path.split("/", 3)
                        data = state["committed"][int(attempt)]["bytes"][relative]
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    if not self.authenticate():
                        return
                    with lock:
                        if path == "/runtime/barrier":
                            if state["attempt"] == 2:
                                restored = outputs[2] / ".pai-resume/replica-0/checkpoint-0" / state["committed"][1]["hash"]
                                if not (restored / ".pai-restore-receipt.json").is_file():
                                    state["errors"].append("barrier reached before restore receipt")
                            self.send(200, {"released": True})
                        elif path == "/runtime/checkpoints":
                            state["restores"] += 1
                            committed = state["committed"][1]
                            root = outputs[2] / ".pai-resume/replica-0/checkpoint-0" / committed["hash"]
                            self.send(200, {"checkpoints": [{
                                "index": 0, "path": str(outputs[2]), "destination": str(root),
                                "publicationId": committed["publication"], "manifestHash": committed["hash"],
                                "source": {"workflowId": "cpu-recovery", "task": "train", "attempt": 1, "epoch": "epoch-1"},
                                "files": [{**file, "versionId": "immutable-v1", "checksumType": "FULL_OBJECT",
                                           "url": state["endpoint"] + "/objects/1/" + file["path"]}
                                          for file in committed["files"]],
                            }]})
                        else:
                            self.send(404)

                def do_PUT(self):
                    # Signed object transfers must not forward the runtime bearer.
                    if self.headers.get("Authorization"):
                        state["errors"].append("object PUT received runtime authorization")
                    relative = unquote(urlsplit(self.path).path).split("/", 3)[3]
                    data = self.rfile.read(int(self.headers["Content-Length"]))
                    with lock:
                        state["uploads"][relative] = data
                    self.send(200)

                def do_POST(self):
                    if not self.authenticate():
                        return
                    value = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                    path = urlsplit(self.path).path
                    with lock:
                        attempt = state["attempt"]
                        if path == "/runtime/uploads":
                            state["uploads"] = {}
                            self.send(200, {"uploads": [{"path": file["path"],
                                "url": state["endpoint"] + f"/put/{attempt}/" + file["path"]} for file in value["files"]]})
                        elif path == "/runtime/uploads/complete":
                            for file in value["files"]:
                                data = state["uploads"].get(file["path"], b"")
                                import base64
                                if len(data) != file["size"] or base64.b64encode(hashlib.sha256(data).digest()).decode() != file["checksumSHA256"]:
                                    state["errors"].append("checkpoint publication did not match uploaded bytes")
                                    self.send(409)
                                    return
                            manifest = json.dumps(value, sort_keys=True).encode()
                            state["committed"][attempt] = {
                                "files": value["files"], "bytes": dict(state["uploads"]),
                                "hash": hashlib.sha256(manifest).hexdigest(),
                                "publication": hashlib.sha256(b"publication" + manifest).hexdigest(),
                            }
                            self.send(204)
                        elif path == "/runtime/state":
                            if value["phase"] in ("SUCCEEDED", "FAILED") and attempt not in state["committed"]:
                                state["errors"].append("terminal report before checkpoint commit")
                            self.send(204)
                        elif path == "/runtime/heartbeat":
                            self.send(204)
                        else:
                            self.send(404)

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            state["endpoint"] = f"http://127.0.0.1:{server.server_port}"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            scripts = Path(__file__).parent
            common_args = ["--num-envs", "2", "--n-steps", "32", "--batch-size", "32",
                           "--checkpoint-every", "64", "--eval-episodes", "1", "--seed", "7"]

            def execute(attempt, steps, reschedule=False):
                state["attempt"] = attempt
                contract = {"workflowId": "cpu-recovery", "projectId": "p", "task": "train",
                            "attempt": attempt, "epoch": f"epoch-{attempt}", "outputPath": str(outputs[attempt]),
                            "checkpointRestore": attempt > 1, "exitActions": {"COMPLETE": 0, "RESCHEDULE": 75},
                            "checkpoint": [{"path": str(outputs[attempt]), "url": "s3://artifacts/projects/p/checkpoints/",
                                            "frequency": "1h", "regex": r"^(final|checkpoints/step-[0-9]+)/(model\.zip|vecnormalize\.pkl|manifest\.json)$"}]}
                train = [sys.executable, str(scripts / "train.py"), "--output-dir", str(outputs[attempt]),
                         "--total-steps", str(steps), *common_args]
                command = [sys.executable, "-c",
                           "import subprocess; subprocess.run(" + repr(train) + ", check=True); raise SystemExit(75)"] if reschedule else train
                environment = {**os.environ, "MUJOCO_GL": "osmesa", "PAI_WORKFLOW_ID": "cpu-recovery",
                               "PAI_TASK_NAME": "train", "PAI_ATTEMPT": str(attempt),
                               "PAI_RUNTIME_ENDPOINT": state["endpoint"],
                               "PAI_RUNTIME_TOKEN": f"attempt-{attempt}-capability",
                               "OSMO_TASK_REPLICA_INDEX": "0"}
                result = subprocess.run([binary, "--contract", json.dumps(contract), "--", *command],
                                        env=environment, capture_output=True, text=True, timeout=180)
                self.assertEqual(result.returncode, 75 if reschedule else 0, result.stdout + result.stderr)

            try:
                execute(1, 128, reschedule=True)
                self.assertIn(1, state["committed"])
                before = PPO.load(outputs[1] / "final/model.zip", device="cpu")
                with (outputs[1] / "final/vecnormalize.pkl").open("rb") as file:
                    stats_before = pickle.load(file)
                self.assertGreater(before._n_updates, 0)
                self.assertTrue(before.policy.optimizer.state_dict()["state"])
                # Remove the entire first output: the second run must use bytes
                # that the real Go runtime uploaded and restores over HTTP.
                shutil.rmtree(outputs[1])
                execute(2, 64)
                initial = PPO.load(outputs[2] / "initial/model.zip", device="cpu")
                after = PPO.load(outputs[2] / "final/model.zip", device="cpu")
                self.assertEqual(initial.num_timesteps, 128)
                self.assertEqual(initial._n_updates, before._n_updates)
                for name, value in before.policy.state_dict().items():
                    self.assertTrue(torch.equal(value, initial.policy.state_dict()[name]), name)
                old_optimizer, restored_optimizer = before.policy.optimizer.state_dict(), initial.policy.optimizer.state_dict()
                self.assertEqual(old_optimizer["param_groups"], restored_optimizer["param_groups"])
                for parameter, values in old_optimizer["state"].items():
                    for name, value in values.items():
                        restored = restored_optimizer["state"][parameter][name]
                        self.assertTrue(torch.equal(value, restored) if torch.is_tensor(value) else value == restored, name)
                with (outputs[2] / "initial/vecnormalize.pkl").open("rb") as file:
                    stats_initial = pickle.load(file)
                np.testing.assert_array_equal(stats_before.obs_rms.mean, stats_initial.obs_rms.mean)
                np.testing.assert_array_equal(stats_before.obs_rms.var, stats_initial.obs_rms.var)
                self.assertEqual(stats_before.obs_rms.count, stats_initial.obs_rms.count)
                self.assertEqual(after.num_timesteps, 192)
                self.assertGreater(after._n_updates, before._n_updates)
                training = json.loads((outputs[2] / "training.json").read_text())
                self.assertEqual(training["resumeSource"], "runtime")
                self.assertEqual(training["initialTimesteps"], 128)
                self.assertTrue(training["resumeBundle"].endswith("/final"))
                self.assertEqual(state["restores"], 1)
                self.assertEqual(state["errors"], [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
