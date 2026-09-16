"""Select a complete PPO bundle from the runtime's verified private restore roots."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def _regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("runtime checkpoint must contain regular, unlinked files")
    return info


def _json(path):
    if _regular(path).st_size > 1024 * 1024:
        raise ValueError("runtime checkpoint metadata exceeds limit")
    return json.loads(path.read_text())


def _restore_root(output, key, value):
    root = Path(value)
    if not root.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")[1:]):
        raise ValueError("invalid runtime checkpoint path")
    try:
        relative = root.relative_to(output)
    except ValueError as error:
        raise ValueError("runtime checkpoint is outside the new output directory") from error
    parts = relative.parts
    if len(parts) != 4 or parts[0] != ".pai-resume" or not re.fullmatch(r"replica-\d+", parts[1]) \
            or not re.fullmatch(r"checkpoint-\d+", parts[2]) or not re.fullmatch(r"[a-f0-9]{64}", parts[3]):
        raise ValueError("invalid private runtime restore root")
    cursor = output
    for part in parts:
        cursor = cursor / part
        if not stat.S_ISDIR(cursor.lstat().st_mode):
            raise ValueError("runtime checkpoint root contains a symlink or non-directory")
    receipt = _json(root / ".pai-restore-receipt.json")
    if receipt.get("version") != 1 or receipt.get("path") != key or receipt.get("manifestHash") != root.name \
            or not re.fullmatch(r"[a-f0-9]{64}", receipt.get("publicationId", "")):
        raise ValueError("runtime restore receipt identity mismatch")
    target, source = receipt.get("target", {}), receipt.get("source", {})
    for environment, field in (("PAI_WORKFLOW_ID", "workflowId"), ("PAI_TASK_NAME", "task")):
        if os.environ.get(environment) and target.get(field) != os.environ[environment]:
            raise ValueError("runtime restore receipt belongs to another task")
    if os.environ.get("PAI_ATTEMPT") and target.get("attempt") != int(os.environ["PAI_ATTEMPT"]):
        raise ValueError("runtime restore receipt belongs to another attempt")
    if not target.get("workflowId") or not target.get("task") or not source.get("workflowId") \
            or not isinstance(target.get("attempt"), int) or not isinstance(source.get("attempt"), int) \
            or source.get("task") != target.get("task"):
        raise ValueError("runtime restore receipt has no valid attempt lineage")
    if source["workflowId"] == target["workflowId"] and source["attempt"] >= target["attempt"]:
        raise ValueError("runtime restore source is not a previous attempt")
    return root


def runtime_resume_bundle(output, task):
    """None means a declared cold start; a nonempty bad restore never falls back."""
    encoded = os.environ.get("PAI_RESUME_CHECKPOINTS", "")
    if not encoded:
        return None
    if len(encoded.encode()) > 65536:
        raise ValueError("runtime checkpoint mapping exceeds limit")
    mapping = json.loads(encoded)
    if not isinstance(mapping, dict) or len(mapping) > 64:
        raise ValueError("runtime checkpoint mapping must be an object")
    if not mapping:
        return None
    output = Path(output).resolve(strict=True)
    candidates = []
    visited = 0
    for key, value in mapping.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("invalid runtime checkpoint mapping entry")
        root = _restore_root(output, key, value)
        for directory, directories, files in os.walk(root, followlinks=False):
            visited += 1
            if visited > 10000:
                raise ValueError("runtime checkpoint bundle search exceeds limit")
            # save_bundle publishes directories by atomic rename; hidden partial
            # directories and runtime receipts are not complete model bundles.
            directories[:] = [name for name in directories if not name.startswith(".")]
            for name in directories:
                if (Path(directory) / name).is_symlink():
                    raise ValueError("runtime checkpoint tree contains a symlink")
            if "manifest.json" not in files:
                continue
            bundle = Path(directory)
            if not all((bundle / name).exists() for name in ("model.zip", "vecnormalize.pkl")):
                continue
            metadata = _json(bundle / "manifest.json")
            if metadata.get("schemaVersion") != 1 or metadata.get("algorithm") != "PPO" or metadata.get("task") != task:
                continue
            timesteps, updates = metadata.get("timesteps"), metadata.get("updates")
            if type(timesteps) is not int or timesteps < 0 or type(updates) is not int or updates < 0:
                raise ValueError("runtime PPO checkpoint counters are invalid")
            for name in ("model.zip", "vecnormalize.pkl"):
                _regular(bundle / name)
                with (bundle / name).open("rb") as data:
                    digest = hashlib.file_digest(data, "sha256").hexdigest()
                if metadata.get("sha256", {}).get(name) != digest:
                    raise ValueError(f"runtime PPO checkpoint digest mismatch: {name}")
            candidates.append(((timesteps, updates, bundle.name == "final", str(bundle)), bundle))
    if not candidates:
        raise ValueError("runtime restore contains no complete compatible PPO bundle")
    return max(candidates, key=lambda candidate: candidate[0])[1]
