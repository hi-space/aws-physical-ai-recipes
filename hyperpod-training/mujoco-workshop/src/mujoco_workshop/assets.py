"""Locate the SO-101 MJCF description (google-deepmind/mujoco_menagerie, ``robotstudio_so101``).

The model is not vendored in this repository. ``scripts/setup_mujoco_env.sh`` does a sparse
checkout of the menagerie at a pinned commit into ``/fsx/scratch/mujoco_menagerie`` so every
cluster node sees the same files. Override with ``MUJOCO_MENAGERIE_DIR`` when running elsewhere.
"""

import os
from pathlib import Path

MENAGERIE_REPO = "https://github.com/google-deepmind/mujoco_menagerie.git"
# Pinned so every participant trains against the same kinematics/actuator gains.
MENAGERIE_COMMIT = "ac6b2b09983786f3036cab1000221017fa2193b4"
MODEL_SUBDIR = "robotstudio_so101"
DEFAULT_MENAGERIE_DIR = "/fsx/scratch/mujoco_menagerie"


def menagerie_dir() -> Path:
    return Path(os.environ.get("MUJOCO_MENAGERIE_DIR", DEFAULT_MENAGERIE_DIR))


def so101_scene_xml() -> Path:
    """Path to ``robotstudio_so101/scene.xml`` (arm + floor + lighting)."""
    xml = menagerie_dir() / MODEL_SUBDIR / "scene.xml"
    if not xml.is_file():
        raise FileNotFoundError(
            f"SO-101 MJCF not found at {xml}. Run hyperpod-training/scripts/setup_mujoco_env.sh "
            f"(it checks out {MENAGERIE_REPO}@{MENAGERIE_COMMIT[:7]} into {menagerie_dir()}), "
            "or point MUJOCO_MENAGERIE_DIR at a mujoco_menagerie checkout."
        )
    return xml
