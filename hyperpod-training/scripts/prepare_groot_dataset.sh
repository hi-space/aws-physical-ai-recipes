#!/bin/bash
# Download the SO-101 LeRobot dataset to FSx and make it loadable by GR00T.
#
# Both orchestration paths need this before fine-tuning, and neither had it:
#   Slurm  finetune_groot_venv.sbatch expects /fsx/datasets/groot/<DATASET>
#   EKS    k8s-templates/setup/groot-setup-job.yaml runs this script
#
# Two things happen here, and the second is the non-obvious one:
#
#   1. Download. LightwheelAI/so101-place-orange is a public LeRobot v2.1
#      dataset (61 episodes, 42981 frames, 30 fps, so101_follower, 6 DOF,
#      front + wrist cameras at 480x640).
#
#   2. Write meta/modality.json. GR00T needs this file to map its own modality
#      keys onto the dataset's raw columns, but the upstream dataset does not
#      ship one -- the fine-tune fails on a missing-key error without it. The
#      mapping is not guesswork: Isaac-GR00T ships examples/SO100/modality.json
#      for exactly this arm, and its spans (state/action 0-5 arm, 5-6 gripper)
#      and video keys (front, wrist) match both the dataset's meta/info.json
#      features and the keys configs/so101_modality.py registers. So we copy
#      the upstream file rather than hand-rolling one, and fall back to an
#      inline copy only if the checkout is unavailable.
#
# Prerequisites:
#   - FSx mounted at /fsx
#   - /fsx/envs/gr00t built by setup_groot_env.sh (provides huggingface_hub)
#   - Network access to huggingface.co
#
# Usage:
#   bash /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/scripts/prepare_groot_dataset.sh
#   DATASET=my-data HF_REPO=org/my-data bash prepare_groot_dataset.sh
#
# Environment Variables:
#   DATASET       Directory name under DATASET_ROOT (default: so101-place-orange)
#   HF_REPO       Hugging Face dataset repo (default: LightwheelAI/so101-place-orange)
#   DATASET_ROOT  Parent directory (default: /fsx/datasets/groot)
#   GR00T_ENV     venv providing huggingface_hub (default: /fsx/envs/gr00t)
#   GR00T_REPO    Isaac-GR00T checkout holding the reference modality.json
#                 (default: /fsx/scratch/Isaac-GR00T)
#   HF_TOKEN      Only needed for a gated HF_REPO; the default repo is public

set -euo pipefail

# A Slurm node runs this as ubuntu and needs sudo for root-owned /fsx paths;
# the EKS setup Job runs it as root in a container with no sudo binary.
SUDO="$(command -v sudo || true)"

DATASET="${DATASET:-so101-place-orange}"
HF_REPO="${HF_REPO:-LightwheelAI/so101-place-orange}"
DATASET_ROOT="${DATASET_ROOT:-/fsx/datasets/groot}"
DATASET_PATH="${DATASET_ROOT}/${DATASET}"
GR00T_ENV="${GR00T_ENV:-/fsx/envs/gr00t}"
GR00T_REPO="${GR00T_REPO:-/fsx/scratch/Isaac-GR00T}"
export HF_HOME="${HF_HOME:-/fsx/scratch/.cache/huggingface}"

echo "=================================================="
echo "GR00T Dataset Preparation"
echo "=================================================="
echo "HF repo:  ${HF_REPO}"
echo "Target:   ${DATASET_PATH}"
echo "venv:     ${GR00T_ENV}"

PY="${GR00T_ENV}/bin/python"
if [ ! -x "${PY}" ]; then
    echo "ERROR: GR00T venv not found at ${GR00T_ENV}"
    echo "  Build it first: scripts/setup_groot_env.sh"
    exit 1
fi

echo ""
echo "[1/3] Creating ${DATASET_ROOT}..."
${SUDO} mkdir -p "${DATASET_ROOT}" "${HF_HOME}"
${SUDO} chmod 777 "${DATASET_ROOT}" 2>/dev/null || true

# snapshot_download resumes and skips files already present, so a re-run after a
# network drop costs only the remaining files.
echo ""
echo "[2/3] Downloading ${HF_REPO} (~1.5 GB: 61 parquet + 122 mp4)..."
HF_REPO="${HF_REPO}" DATASET_PATH="${DATASET_PATH}" "${PY}" - <<'PY'
import os
from huggingface_hub import snapshot_download

path = snapshot_download(
    repo_id=os.environ["HF_REPO"],
    repo_type="dataset",
    local_dir=os.environ["DATASET_PATH"],
    token=os.environ.get("HF_TOKEN") or None,
)
print(f"  downloaded to {path}")
PY

echo ""
echo "[3/3] Installing meta/modality.json..."
MODALITY_SRC="${GR00T_REPO}/examples/SO100/modality.json"
MODALITY_DST="${DATASET_PATH}/meta/modality.json"
mkdir -p "${DATASET_PATH}/meta"
if [ -f "${MODALITY_DST}" ]; then
    echo "  Already present, keeping it."
elif [ -f "${MODALITY_SRC}" ]; then
    cp "${MODALITY_SRC}" "${MODALITY_DST}"
    echo "  Copied from ${MODALITY_SRC}"
else
    # Same content as the upstream file, kept here so dataset prep does not
    # hard-depend on the Isaac-GR00T checkout being present.
    cat > "${MODALITY_DST}" <<'JSON'
{
    "state": {
        "single_arm": { "start": 0, "end": 5 },
        "gripper": { "start": 5, "end": 6 }
    },
    "action": {
        "single_arm": { "start": 0, "end": 5 },
        "gripper": { "start": 5, "end": 6 }
    },
    "video": {
        "front": { "original_key": "observation.images.front" },
        "wrist": { "original_key": "observation.images.wrist" }
    },
    "annotation": {
        "human.task_description": { "original_key": "task_index" }
    }
}
JSON
    echo "  Wrote inline copy (${GR00T_REPO} not available)"
fi

# Fail here rather than 20 minutes into a fine-tune: check that the modality
# spans and video keys actually match what the dataset declares in info.json.
DATASET_PATH="${DATASET_PATH}" "${PY}" - <<'PY'
import json
import os
import sys
from pathlib import Path

root = Path(os.environ["DATASET_PATH"])
info = json.loads((root / "meta" / "info.json").read_text())
modality = json.loads((root / "meta" / "modality.json").read_text())
features = info["features"]
problems = []

for section in ("state", "action"):
    key = "observation.state" if section == "state" else "action"
    declared = features[key]["shape"][0]
    spanned = max(v["end"] for v in modality[section].values())
    if declared != spanned:
        problems.append(f"{section}: info.json has {declared} dims, modality.json spans {spanned}")

for name, spec in modality["video"].items():
    if spec["original_key"] not in features:
        problems.append(f"video '{name}' -> '{spec['original_key']}' missing from info.json")

episodes = info["total_episodes"]
parquet = len(list(root.rglob("*.parquet")))
videos = len(list(root.rglob("*.mp4")))
if parquet < episodes:
    problems.append(f"only {parquet}/{episodes} episode parquet files present")

if problems:
    print("ERROR: dataset and modality.json disagree:")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print(f"  verify: {episodes} episodes, {info['total_frames']} frames @ {info['fps']} fps")
print(f"  verify: {parquet} parquet, {videos} mp4, robot {info['robot_type']}, "
      f"LeRobot {info['codebase_version']}")
print(f"  verify: modality keys state/action={list(modality['state'])} "
      f"video={list(modality['video'])}")
PY

echo ""
echo "=================================================="
echo "Dataset ready: ${DATASET_PATH}"
echo "  Size: $(du -sh "${DATASET_PATH}" 2>/dev/null | cut -f1)"
echo ""
echo "Next (Slurm):"
echo "  DATASET=${DATASET} sbatch slurm-templates/vla/finetune_groot_venv.sbatch"
echo "Next (EKS):"
echo "  ./render.sh rl/groot-finetune-job.yaml --apply"
echo "=================================================="
