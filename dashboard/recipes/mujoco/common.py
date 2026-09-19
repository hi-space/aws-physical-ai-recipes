"""Checkpoint contracts for the workshop's real SO-101 MuJoCo environment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pai_live import LiveFrames  # noqa: F401,E402 — re-export; canonical home is dashboard/recipes/pai_live.py

import gymnasium as gym
import mujoco
import mujoco_workshop  # noqa: F401 — original workshop task registration
import stable_baselines3
from mujoco_workshop.assets import MENAGERIE_COMMIT, so101_scene_xml
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv

TASK = "Workshop-SO101-Reach-MuJoCo-v0"


def digest(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as file:
        json.dump(value, file, indent=2, allow_nan=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def make_env(task=TASK, num_envs=1, seed=42, render=False, width=640, height=480):
    if task != TASK:
        raise ValueError(f"Unsupported task: {task}; success semantics are defined only for {TASK}")
    env = DummyVecEnv([
        lambda: Monitor(gym.make(task, render_mode="rgb_array" if render else None, width=width, height=height))
        for _ in range(num_envs)
    ])
    env.seed(seed)
    return env


def save_bundle(model, env, path, *, task, seed, parent=None):
    """Publish a bundle only once both model and its current stats are saved."""
    path = Path(path)
    stage = path.with_name("." + path.name + ".partial")
    stage.mkdir(parents=True, exist_ok=False)
    model.save(stage / "model.zip")
    env.save(stage / "vecnormalize.pkl")
    metadata = {
        "schemaVersion": 1, "algorithm": "PPO", "task": task, "seed": seed,
        "timesteps": model.num_timesteps, "updates": model._n_updates,
        "normalization_count": float(env.obs_rms.count),
        "sha256": {f: digest(stage / f) for f in ("model.zip", "vecnormalize.pkl")},
        "simulator": {"name": "MuJoCo", "version": mujoco.__version__,
                      "sceneSha256": digest(so101_scene_xml()), "menagerieCommit": MENAGERIE_COMMIT},
        "sourceRevision": os.environ.get("RECIPE_SOURCE_REVISION", "local"),
        "sourceSha256": {name: digest(Path(__file__).with_name(name)) for name in ("common.py", "train.py", "evaluate.py")},
        "packages": {"stable_baselines3": stable_baselines3.__version__, "gymnasium": gym.__version__},
        "parentCheckpoint": parent,
        "resumeSemantics": "optimizer and normalization restored; simulator/RNG state starts from seed",
    }
    write_json(stage / "manifest.json", metadata)
    os.replace(stage, path)
    return metadata


def load_bundle(path, task=TASK):
    path = Path(path).resolve()
    metadata = json.loads((path / "manifest.json").read_text())
    if metadata["task"] != task:
        raise ValueError("checkpoint task mismatch")
    for filename in ("model.zip", "vecnormalize.pkl"):
        if digest(path / filename) != metadata["sha256"][filename]:
            raise ValueError(f"checkpoint digest mismatch: {filename}")
    if metadata["simulator"]["sceneSha256"] != digest(so101_scene_xml()):
        raise ValueError("checkpoint scene digest mismatch")
    return path, metadata


def alias_bundle(source, output, name):
    """Legacy file names have explicitly paired normalization files."""
    source, output = Path(source), Path(output)
    shutil.copyfile(source / "model.zip", output / f"model_{name}.zip")
    shutil.copyfile(source / "vecnormalize.pkl", output / f"vecnormalize_{name}.pkl")
