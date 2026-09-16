"""Actual CPU SB3 / official GR00T PyTorch inference and performance benchmarks.

Performance inputs follow the workshop's fixed-shape synthetic observation probe;
these results are not robot task success or physical hardware validation.
"""
import hashlib
import http.server
import importlib.metadata
import json
import os
from pathlib import Path
import pickle
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time


def write(path, data):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as file:
        json.dump(data, file, indent=2, allow_nan=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination) or not (member.isdir() or member.isfile()):
                raise ValueError("unsafe model archive path/link/device")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)


def main():
    cfg = json.loads(Path("/execution.json").read_text())
    engine = cfg["profile"]["engine"]
    observed_arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "amd64" if platform.machine() in ("x86_64", "amd64") else "unsupported"
    if observed_arch != cfg["profile"]["architecture"]:
        raise ValueError("runtime architecture mismatch")
    with Path("/model/checkpoint").open("rb") as file:
        checkpoint_hash = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            checkpoint_hash.update(chunk)
        if checkpoint_hash.hexdigest() != cfg["model"]["checkpoint"]["sha256"]:
            raise ValueError("runtime checkpoint digest mismatch")
    import numpy as np
    import torch
    if engine == "sb3-ppo":
        from stable_baselines3 import PPO
        policy = PPO.load("/model/checkpoint", device="cpu")
        with open("/model/vecnormalize.pkl", "rb") as file:
            normalization_bytes = file.read()
            if hashlib.sha256(normalization_bytes).hexdigest() != cfg["model"]["normalization"]["sha256"]:
                raise ValueError("runtime normalization digest mismatch")
            file.seek(0)
            normalization = pickle.load(file)
        version = importlib.metadata.version("stable-baselines3")
        sample = np.zeros((1, *policy.observation_space.shape), dtype=np.float32)
        def infer(obs):
            action, _ = policy.predict(normalization.normalize_obs(np.asarray(obs, dtype=np.float32)), deterministic=True)
            if not np.isfinite(action).all():
                raise ValueError("non-finite policy output")
            return action
    elif engine == "groot-pytorch":
        from gr00t.data.embodiment_tags import EmbodimentTag
        from gr00t.policy.gr00t_policy import Gr00tPolicy
        workspace = tempfile.TemporaryDirectory(prefix="groot-model-")
        safe_extract("/model/checkpoint", workspace.name)
        model_path = Path(workspace.name)
        # Archive contract: config/processor/model files at the root, no guessed nested folder.
        policy = Gr00tPolicy(embodiment_tag=EmbodimentTag.NEW_EMBODIMENT, model_path=str(model_path), device="cuda:0") if cfg["purpose"] == "benchmark" else None
        version = importlib.metadata.version("gr00t")
        rng = np.random.default_rng(42)
        sample = {"video": {key: rng.integers(0, 255, (1, 1, 224, 224, 3), dtype=np.uint8) for key in ("front", "wrist")},
                  "state": {"single_arm": np.zeros((1, 1, 5), np.float32), "gripper": np.zeros((1, 1, 1), np.float32)},
                  "language": {"annotation.human.task_description": [["pick orange"]]}}
        infer = policy.get_action if policy is not None else None
    else:
        raise ValueError("no verified implementation for this engine")
    ready = {"status": "ready", "kind": "model-ready", "operationId": cfg["operationId"], "deviceId": cfg["deviceId"],
             "modelId": cfg["model"]["id"], "checkpointDigest": cfg["model"]["checkpoint"]["sha256"],
             "normalizationDigest": cfg["model"].get("normalization", {}).get("sha256") if cfg["model"].get("normalization") else None,
             "recipeHash": cfg["profile"]["recipeHash"], "componentVersion": cfg["profile"]["version"], "architecture": observed_arch}
    if cfg["purpose"] == "benchmark":
        for _ in range(cfg["warmup"]):
            infer(sample)
        latencies = []
        for _ in range(cfg["iterations"]):
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            started = time.perf_counter()
            infer(sample)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            latencies.append((time.perf_counter() - started) * 1000)
        average = statistics.mean(latencies)
        report = {"schemaVersion": 1, "type": "inference_benchmark", "operationId": cfg["operationId"], "deviceId": cfg["deviceId"],
                  "modelId": cfg["model"]["id"], "checkpointDigest": cfg["model"]["checkpoint"]["sha256"],
                  "engine": {"name": engine, "version": version, "runtimeImage": cfg["profile"]["runtimeImage"]},
                  "platform": {"architecture": observed_arch, "system": platform.system(), "machine": platform.machine(),
                               "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None},
                  "inputKind": "synthetic_observation_performance_probe", "physicalHardwareTested": False,
                  "results": [{"mode": engine, "avg_ms": average, "p50_ms": float(np.percentile(latencies, 50)),
                               "p95_ms": float(np.percentile(latencies, 95)), "p99_ms": float(np.percentile(latencies, 99)),
                               "std_ms": statistics.pstdev(latencies), "hz": 1000 / average, "iterations": len(latencies)}]}
        write("/output/benchmark.json", report)
        write("/output/readiness.json", ready)
        return
    if engine == "groot-pytorch":
        # The official GR00T service protocol, not a fabricated replacement endpoint.
        child = subprocess.Popen([sys.executable, "-m", "gr00t.eval.run_gr00t_server", "--model-path", str(model_path),
                                  "--embodiment-tag", "NEW_EMBODIMENT", "--host", "0.0.0.0", "--port", "5555"])
        del policy
        torch.cuda.empty_cache()
        deadline = time.monotonic() + 900
        while child.poll() is None and time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", 5555), timeout=1):
                    write("/output/readiness.json", ready)
                    break
            except OSError:
                time.sleep(1)
        if not Path("/output/readiness.json").is_file():
            child.terminate()
            raise RuntimeError("official GR00T server did not become ready")
        raise SystemExit(child.wait())
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/health":
                self.send_error(404)
                return
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ready","motionControl":false}')
        def do_POST(self):
            try:
                size = int(self.headers.get("content-length", "0"))
                if self.path != "/predict" or not 0 < size <= 1024 * 1024:
                    raise ValueError("only bounded prediction requests are supported")
                data = json.loads(self.rfile.read(size))
                if set(data) != {"observation"}:
                    raise ValueError("no motion/control commands are accepted")
                obs = np.asarray(data["observation"], dtype=np.float32)
                if obs.shape != sample.shape or not np.isfinite(obs).all():
                    raise ValueError("observation shape/values mismatch")
                response = json.dumps({"actionPrediction": infer(obs).tolist(), "motionControl": False}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(response)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_error(400, str(error))
    infer(sample)
    with http.server.ThreadingHTTPServer(("0.0.0.0", 5555), Handler) as server:
        write("/output/readiness.json", ready)
        server.serve_forever()


if __name__ == "__main__":
    main()
