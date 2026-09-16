"""Greengrass component runner: version-pinned model staging and owned-container lifecycle.

Runtime prerequisites: Python + vendored boto3, Docker/ECR credential helper, and a
token-exchange role limited to the configured model versions and operation prefix.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import tempfile
import time


def architecture():
    value = platform.machine().lower()
    if value in ("x86_64", "amd64"):
        return "amd64"
    if value in ("aarch64", "arm64"):
        return "arm64"
    raise ValueError(f"unsupported architecture: {value}")


def write_json(path, data):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as file:
        json.dump(data, file, indent=2, allow_nan=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def download_pin(pin, output, s3, project_id):
    if (pin.get("checksumType") != "FULL_OBJECT" or not pin.get("versionId") or pin["versionId"] == "null"
            or not pin["key"].startswith(f"projects/{project_id}/") or ".." in pin["key"].split("/")):
        raise ValueError("model artifact must be a pinned project object with a full checksum")
    expected = pin["sha256"]
    if base64.b64encode(bytes.fromhex(expected)).decode() != pin["checksumSHA256"]:
        raise ValueError("model checksum formats disagree")
    response = s3.get_object(Bucket=pin["bucket"], Key=pin["key"], VersionId=pin["versionId"], ChecksumMode="ENABLED")
    if response.get("VersionId") != pin["versionId"]:
        raise ValueError("download VersionId mismatch")
    digest = hashlib.sha256()
    total = 0
    temporary = Path(output).with_suffix(".partial")
    try:
        with temporary.open("wb") as file:
            for chunk in response["Body"].iter_chunks(chunk_size=1024 * 1024):
                total += len(chunk)
                if total > pin["bytes"]:
                    raise ValueError("model exceeds declared bytes")
                digest.update(chunk)
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        if total != pin["bytes"] or digest.hexdigest() != expected:
            raise ValueError("downloaded model checksum mismatch")
        os.replace(temporary, output)
    finally:
        response["Body"].close()
        temporary.unlink(missing_ok=True)


def publish_json(s3, destination, value):
    body = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
    try:
        response = s3.put_object(Bucket=destination["bucket"], Key=destination["key"], Body=body,
                                 ContentType="application/json", ChecksumAlgorithm="SHA256",
                                 ChecksumSHA256=checksum, IfNoneMatch="*")
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") != "PreconditionFailed":
            raise
        previous = s3.get_object(Bucket=destination["bucket"], Key=destination["key"], ChecksumMode="ENABLED")
        try:
            if previous["Body"].read() != body:
                raise ValueError("operation already has different evidence; use a new operation")
        finally:
            previous["Body"].close()
        response = previous
    if not response.get("VersionId") or response["VersionId"] == "null":
        raise ValueError("operation archive must have S3 versioning enabled")
    return response["VersionId"]


def readiness(config):
    return {"status": "ready", "kind": "communication-only" if config["purpose"] == "communication" else "model-ready",
            "operationId": config["operationId"], "deviceId": config["deviceId"],
            "modelId": config.get("model", {}).get("id"),
            "checkpointDigest": config.get("model", {}).get("checkpoint", {}).get("sha256"),
            "normalizationDigest": config.get("model", {}).get("normalization", {}).get("sha256") if config.get("model", {}).get("normalization") else None,
            "recipeHash": config["profile"]["recipeHash"], "componentVersion": config["profile"]["version"],
            "architecture": architecture()}


def main():
    config = json.loads(os.environ["EDGE_EXECUTION_CONFIG"])
    if config.get("edgeContract") != "physical-ai-pinned-v1" or config["profile"]["architecture"] != architecture():
        raise ValueError("component contract/architecture mismatch")
    if not config["report"]["key"].startswith(f'projects/{config["projectId"]}/edge/{config["deviceId"]}/operations/{config["operationId"]}/'):
        raise ValueError("report destination is not scoped to this operation")
    import boto3
    s3 = boto3.client("s3")
    ready_destination = {**config["report"], "key": config["report"]["key"].replace("benchmark.json", "readiness.json")}
    if config["purpose"] == "communication":
        if config.get("model") or config["profile"]["engine"] != "virtual-communication":
            raise ValueError("communication harness cannot execute a model")
        from virtual_device import run_probe
        report = run_probe(config["iterations"])
        report.update({"schemaVersion": 1, "operationId": config["operationId"], "deviceId": config["deviceId"],
                       "engine": {"name": "virtual-communication", "version": "stdlib-echo-v1"},
                       "platform": {"architecture": architecture(), "system": platform.system(), "machine": platform.machine()}})
        publish_json(s3, config["report"], report)
        publish_json(s3, ready_destination, readiness(config))
        print(json.dumps(report, allow_nan=False))
        return
    with tempfile.TemporaryDirectory(prefix="pai-edge-") as folder:
        root = Path(folder)
        model_dir, output = root / "model", root / "output"
        model_dir.mkdir()
        output.mkdir()
        model = config["model"]
        download_pin(model["checkpoint"], model_dir / "checkpoint", s3, config["projectId"])
        if model.get("normalization"):
            download_pin(model["normalization"], model_dir / "vecnormalize.pkl", s3, config["projectId"])
        write_json(root / "execution.json", config)
        runtime = Path(__file__).with_name("runtime.py").resolve()
        command = ["docker", "run", "--rm", "--cidfile", str(root / "container.id"), "--user", f"{os.getuid()}:{os.getgid()}",
                   "--mount", f"type=bind,src={model_dir},dst=/model,readonly",
                   "--mount", f"type=bind,src={runtime},dst=/opt/edge/runtime.py,readonly",
                   "--mount", f"type=bind,src={root / 'execution.json'},dst=/execution.json,readonly",
                   "--mount", f"type=bind,src={output},dst=/output"]
        if config["profile"]["engine"] == "groot-pytorch":
            command.extend(["--gpus", "all", "--shm-size", "8g"])
        if config["purpose"] == "inference":
            command.extend(["-p", "127.0.0.1:5555:5555"])
        else:
            command.extend(["--network", "none"])
        command.extend(["--entrypoint", "python", config["profile"]["runtimeImage"], "/opt/edge/runtime.py"])
        process = subprocess.Popen(command)
        def stop(_signal, _frame):
            process.terminate()  # Docker signal proxy targets only this newly created container.
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            deadline = time.monotonic() + 1200
            while process.poll() is None and not (output / "readiness.json").is_file():
                if time.monotonic() >= deadline:
                    raise TimeoutError("model runtime did not become ready")
                time.sleep(0.25)
            if (output / "readiness.json").is_file():
                ready = json.loads((output / "readiness.json").read_text())
                if ready != readiness(config):
                    raise ValueError("runtime readiness identity mismatch")
                if config["purpose"] == "inference":
                    publish_json(s3, ready_destination, ready)
            code = process.wait()
            if (output / "benchmark.json").is_file():
                report = json.loads((output / "benchmark.json").read_text())
                publish_json(s3, config["report"], report)
                print(json.dumps(report, allow_nan=False))
            if code:
                raise RuntimeError(f"owned model runtime exited with code {code}")
            if config["purpose"] == "benchmark":
                if not (output / "benchmark.json").is_file() or not (output / "readiness.json").is_file():
                    raise RuntimeError("benchmark exited without complete evidence")
                publish_json(s3, ready_destination, ready)
            if config["purpose"] == "inference":
                raise RuntimeError("inference server exited; it is no longer serving")
        finally:
            if process.poll() is None:
                process.terminate()
            cid_file = root / "container.id"
            if cid_file.exists():
                cid = cid_file.read_text().strip()
                if len(cid) == 64 and all(c in "0123456789abcdef" for c in cid):
                    subprocess.run(["docker", "rm", "--force", cid], check=False)


if __name__ == "__main__":
    main()
