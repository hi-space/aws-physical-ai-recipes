"""Test-only launcher for the shipped Isaac Lab recipes; never replaces PPO/rendering."""
import argparse
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading


TASK = "Workshop-SO101-Reach-v0"
MARKER = "PAI_ISAACLAB_DIAGNOSTIC "


def clean(message):
    text = re.sub(r"https?://\S+", "[URL omitted]", str(message))
    text = re.sub(r"(?i)(bearer\s+)\S+", r"\1[redacted]", text)
    return re.sub(r"(?i)((?:token|password|signature|credential|ticket)\s*[=:]\s*)\S+",
                  r"\1[redacted]", text)[:1500]


def category(message):
    text = message.lower()
    if any(word in text for word in ("permission", "read-only", "readonly", "errno 13", "errno 30")):
        return "filesystem-permissions"
    if any(word in text for word in ("cuda", "nvidia", "driver", "vulkan", "gpu", "out of memory")):
        return "gpu-driver-or-memory"
    if any(word in text for word in ("usd", "asset", "nucleus", "omniverse", "could not open")):
        return "simulator-assets"
    if any(word in text for word in ("modulenotfound", "importerror", "typeerror", "unexpected keyword")):
        return "image-recipe-compatibility"
    return "recipe-execution"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        raise ValueError(f"missing nonempty regular file: {path.name}")
    if path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError(f"minimal probe file exceeds 128 MiB: {path.name}")
    return path


def checkpoint(path):
    """Inspect our own freshly produced/pinned tensor-only RSL-RL checkpoint."""
    import torch
    regular(path)
    saved = torch.load(path, map_location="cpu", weights_only=True)
    model = saved["model_state_dict"]
    optimizer = saved["optimizer_state_dict"]
    if not model or not optimizer["state"] or not optimizer["param_groups"]:
        raise ValueError("checkpoint has no learned model/optimizer state")
    state_hash = hashlib.sha256()
    for key, tensor in sorted(model.items()):
        if not torch.is_tensor(tensor) or not torch.isfinite(tensor).all().item():
            raise ValueError("checkpoint model contains nonfinite/non-tensor state")
        state_hash.update(json.dumps([key, str(tensor.dtype), list(tensor.shape)]).encode())
        state_hash.update(tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes())
    steps = []
    for state in optimizer["state"].values():
        for field in ("exp_avg", "exp_avg_sq"):
            if field not in state or not torch.isfinite(state[field]).all().item():
                raise ValueError("checkpoint has missing/nonfinite Adam moments")
        value = state["step"]
        step = float(value.item() if torch.is_tensor(value) else value)
        if not math.isfinite(step) or step <= 0 or not step.is_integer():
            raise ValueError("checkpoint optimizer has not completed an update")
        steps.append(int(step))
    iteration = saved["iter"]
    if not isinstance(iteration, int) or iteration < 0:
        raise ValueError("checkpoint iteration is invalid")
    return {"path": path.name, "sha256": digest(path), "bytes": path.stat().st_size,
            "iteration": iteration, "modelStateSHA256": state_hash.hexdigest(),
            "optimizerSteps": {"min": min(steps), "max": max(steps), "parameters": len(steps)}}


def training_proof(output):
    import yaml
    from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
    training = json.loads(regular(output / "training.json").read_text())
    expected = {"task": TASK, "seed": 42, "iterations": 2, "resume": "",
                "checkpoint": "model_final.pt", "evaluationType": "training_only"}
    if any(training.get(key) != value for key, value in expected.items()):
        raise ValueError("training metadata does not match the requested task/seed/iterations")
    # BaseLoader reads values without constructing Python objects from YAML tags.
    environment = yaml.load(regular(output / "environment.yaml").read_text(), Loader=yaml.BaseLoader)
    agent = yaml.load(regular(output / "agent.yaml").read_text(), Loader=yaml.BaseLoader)
    if (environment["scene"]["num_envs"] != "32" or environment["seed"] != "42"
            or not environment["sim"]["device"].startswith("cuda")
            or agent["seed"] != "42" or agent["save_interval"] != "1"
            or not agent["device"].startswith("cuda")):
        raise ValueError("saved configuration does not use 32 environments, seed 42 and CUDA")
    first = checkpoint(output / "checkpoints/model_0.pt")
    second = checkpoint(output / "checkpoints/model_1.pt")
    final = checkpoint(output / "model_final.pt")
    if (first["iteration"] != 0 or second["iteration"] != 1 or final["iteration"] != 1
            or first["modelStateSHA256"] == final["modelStateSHA256"]
            or second["modelStateSHA256"] != final["modelStateSHA256"]
            or final["optimizerSteps"]["min"] <= first["optimizerSteps"]["max"]):
        raise ValueError("two PPO iterations did not advance learned weights and optimizer state")
    losses = {}
    for event_file in sorted((output / "checkpoints").glob("events.out.tfevents.*")):
        accumulator = EventAccumulator(str(regular(event_file)), size_guidance={"scalars": 100})
        accumulator.Reload()
        for tag in accumulator.Tags()["scalars"]:
            if tag.startswith("Loss/") and tag != "Loss/learning_rate":
                losses.setdefault(tag, []).extend(
                    {"step": event.step, "value": event.value} for event in accumulator.Scalars(tag))
    if len(losses) < 2 or any(
            {item["step"] for item in values} != {0, 1}
            or any(not math.isfinite(item["value"]) for item in values)
            for values in losses.values()):
        raise ValueError("real TensorBoard PPO losses for both iterations are missing/nonfinite")
    return {"training": training, "first": first, "second": second, "final": final, "losses": losses,
            "configuration": {"numEnvs": int(environment["scene"]["num_envs"]),
                              "simulationDevice": environment["sim"]["device"],
                              "policyDevice": agent["device"], "seed": int(agent["seed"]),
                              "stepsPerEnvironment": int(agent["num_steps_per_env"])}}


def gpu_diagnostic(output):
    import torch
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise RuntimeError("CUDA requires exactly one visible NVIDIA GPU; CPU fallback is forbidden")
    # An actual CUDA kernel/synchronization, not a fabricated utilization metric.
    value = torch.arange(16, device="cuda:0", dtype=torch.float32).square().sum()
    torch.cuda.synchronize()
    if value.item() != 1240:
        raise RuntimeError("CUDA arithmetic check failed")
    result = {"available": True, "deviceCount": torch.cuda.device_count(),
              "name": torch.cuda.get_device_name(0), "torchVersion": torch.__version__,
              "cudaVersion": torch.version.cuda, "kernelCheck": float(value.item())}
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, check=True)
        result["driver"] = clean(smi.stdout.strip())
    except FileNotFoundError:
        result["driver"] = "nvidia-smi unavailable; CUDA kernel validated"
    for asset in ("/opt/workshop/src/workshop/robots/usd/so_arm101_flat.usd",
                  "/opt/recipes/isaaclab/train.py", "/opt/recipes/isaaclab/play.py"):
        with regular(Path(asset)).open("rb") as stream:
            stream.read(1)
    probe = output / "e2e-write-check.tmp"
    with probe.open("xb") as stream:
        stream.write(b"fsx write check")
        stream.flush()
        os.fsync(stream.fileno())
    probe.unlink()
    return result


def execute_recipe(argv, timeout):
    tail = deque(maxlen=80)
    child = subprocess.Popen([sys.executable, *argv], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, errors="replace")

    def tee():
        for line in child.stdout:
            value = clean(line.rstrip())
            tail.append(value)
            print(value, flush=True)

    reader = threading.Thread(target=tee, daemon=True)
    reader.start()
    try:
        code = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)
        raise RuntimeError("shipped recipe exceeded its bounded execution deadline") from None
    finally:
        reader.join(timeout=3)
    if code != 0:
        message = "\n".join(tail)
        print(MARKER + json.dumps({"category": category(message), "exitCode": code,
                                  "tail": list(tail)[-15:]}), flush=True)
        raise RuntimeError(f"shipped recipe failed ({category(message)}); raw exit {code}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("train", "video"), required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--checkpoint-sha256")
    parser.add_argument("recipe", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.recipe[1:] if args.recipe[:1] == ["--"] else args.recipe
    if not argv or argv[0] != f"/opt/recipes/isaaclab/{'train' if args.mode == 'train' else 'play'}.py":
        raise ValueError("the existing baked Isaac Lab recipe is required")
    output = Path(os.environ["PAI_OUTPUT_DIR"])
    if not output.is_absolute() or not output.is_dir() or output.is_symlink():
        raise ValueError("compiler-prepared output directory is required")
    proof = {"schemaVersion": 1, "mode": args.mode, "nonce": args.nonce,
             "runId": os.environ["PAI_WORKFLOW_ID"], "taskName": os.environ["PAI_TASK_NAME"],
             "attempt": int(os.environ["PAI_ATTEMPT"])}
    proof["gpu"] = gpu_diagnostic(output)
    print(MARKER + json.dumps({"category": "ready", **proof}), flush=True)
    if args.mode == "video":
        source = Path(argv[argv.index("--checkpoint") + 1])
        if not re.fullmatch("[a-f0-9]{64}", args.checkpoint_sha256 or "") or digest(regular(source)) != args.checkpoint_sha256:
            raise ValueError("hydrated checkpoint differs from the committed training artifact")
        metadata = json.loads(regular(source.parent / "training.json").read_text())
        if metadata["task"] != TASK or metadata["seed"] != 42 or metadata["iterations"] != 2:
            raise ValueError("checkpoint task/seed does not match playback")
        proof["inputCheckpoint"] = checkpoint(source)
    execute_recipe(argv, 7 * 60 if args.mode == "train" else 5 * 60)
    if args.mode == "train":
        proof.update(training_proof(output))
    else:
        videos = sorted((output / "videos").glob("*.mp4"))
        if len(videos) != 1:
            raise ValueError("the shipped playback recipe did not write exactly one MP4")
        video = regular(videos[0])
        with video.open("rb") as stream:
            if stream.read(8)[4:8] != b"ftyp":
                raise ValueError("playback output is not an MP4")
        proof["video"] = {"path": video.relative_to(output).as_posix(),
                          "bytes": video.stat().st_size, "sha256": digest(video)}
    temporary = output / "isaaclab-proof.tmp"
    temporary.write_text(json.dumps(proof, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(output / "isaaclab-proof.json")
    print(MARKER + json.dumps({"category": "completed", "mode": args.mode}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(MARKER + json.dumps({"category": category(str(error)), "error": clean(error)}), flush=True)
        raise SystemExit(86) from None
