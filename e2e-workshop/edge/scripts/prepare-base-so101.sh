#!/usr/bin/env bash
# =============================================================================
# prepare-base-so101.sh  —  Module 2 pre-deployment step
# -----------------------------------------------------------------------------
# Makes the GR00T-N1.6 *base* model runnable on the SO-101 (NEW_EMBODIMENT)
# closed-loop, WITHOUT fine-tuning, by injecting the SO-101 embodiment metadata
# into a lightweight model directory that reuses the base weights via symlinks.
#
# Why this is needed:
#   Gr00tPolicy reads modality configs from processor.get_modality_configs()
#   [embodiment_tag]. The base checkpoint has NO "new_embodiment" entry in its
#   processor_config.json / embodiment_id.json / statistics.json, so running it
#   with --embodiment-tag NEW_EMBODIMENT fails with KeyError('new_embodiment').
#   Injecting these three metadata files (SO-101 modality + dataset normalization)
#   registers new_embodiment with SO-101 dims. The base action head for that slot
#   is UNTRAINED, so the policy produces ~random actions == a genuine pre-fine-tuning
#   baseline (validated: action single_arm (1,16,5) + gripper (1,16,1)).
#
# The three metadata files are embodiment/dataset properties (NOT trained policy
# weights), bundled under edge/assets/so101-base-embodiment/.
#
# Result: a complete model directory (base weights via symlink + injected
# metadata) that the com.workshop.inference component points to via `modelPath`.
#
# Usage:
#   sudo bash prepare-base-so101.sh [BASE_MODEL_DIR] [OUTPUT_DIR]
# Defaults:
#   BASE_MODEL_DIR = /home/ubuntu/environment/efs/GR00T-N1.6-3B
#   OUTPUT_DIR     = <base parent>/GR00T-N1.6-3B-so101
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="${ASSETS_DIR:-$SCRIPT_DIR/../assets/so101-base-embodiment}"

BASE_MODEL_DIR="${1:-/home/ubuntu/environment/efs/GR00T-N1.6-3B}"
BASE_PARENT="$(cd "$(dirname "$BASE_MODEL_DIR")" && pwd)"
BASE_NAME="$(basename "$BASE_MODEL_DIR")"
OUTPUT_DIR="${2:-$BASE_PARENT/GR00T-N1.6-3B-so101}"

echo "=== prepare-base-so101 ==="
echo "  base model : $BASE_MODEL_DIR"
echo "  output dir : $OUTPUT_DIR"
echo "  assets     : $ASSETS_DIR"

# --- validate inputs -------------------------------------------------------
[ -d "$BASE_MODEL_DIR" ] || { echo "ERROR: base model dir not found: $BASE_MODEL_DIR"; exit 1; }
if [ "$(find "$BASE_MODEL_DIR" -maxdepth 1 -name '*.safetensors' | wc -l)" -lt 1 ]; then
  echo "ERROR: no *.safetensors in $BASE_MODEL_DIR (is the base model staged on EFS?)"; exit 1
fi
for f in processor_config.json embodiment_id.json statistics.json; do
  [ -f "$ASSETS_DIR/$f" ] || { echo "ERROR: bundled asset missing: $ASSETS_DIR/$f"; exit 1; }
done

# OUTPUT_DIR must be a sibling of BASE_MODEL_DIR so the relative symlinks resolve
# both on the host and inside the container (when the EFS parent is mounted).
if [ "$(cd "$(dirname "$OUTPUT_DIR")" && pwd)" != "$BASE_PARENT" ]; then
  echo "ERROR: OUTPUT_DIR must be a sibling of BASE_MODEL_DIR (same parent: $BASE_PARENT)"; exit 1
fi

# --- build the SO-101 model directory --------------------------------------
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# 1) symlink every base entry relatively (no multi-GB copy)
shopt -s dotglob
for entry in "$BASE_MODEL_DIR"/*; do
  name="$(basename "$entry")"
  ln -s "../$BASE_NAME/$name" "$OUTPUT_DIR/$name"
done
shopt -u dotglob

# 2) overwrite the three metadata files with the injected (real) copies
#    (remove the symlink FIRST so we never write through it into the base model)
for f in processor_config.json embodiment_id.json statistics.json; do
  rm -f "$OUTPUT_DIR/$f"
  cp "$ASSETS_DIR/$f" "$OUTPUT_DIR/$f"
done

# --- verify ----------------------------------------------------------------
echo "=== verify ==="
python3 - "$OUTPUT_DIR" <<'PYEOF'
import json, sys
d = sys.argv[1]
proc = json.load(open(f"{d}/processor_config.json"))
emb  = json.load(open(f"{d}/embodiment_id.json"))
stat = json.load(open(f"{d}/statistics.json"))
assert "new_embodiment" in json.dumps(proc), "processor_config.json missing new_embodiment"
assert emb.get("new_embodiment") is not None, "embodiment_id.json missing new_embodiment"
assert "new_embodiment" in stat, "statistics.json missing new_embodiment"
print("  new_embodiment registered in processor_config.json / embodiment_id.json / statistics.json  OK")
PYEOF

echo ""
echo "✅ Base SO-101 model directory ready:"
echo "     $OUTPUT_DIR"
echo ""
echo "   Deploy com.workshop.inference with:"
echo "     modelPath     = $OUTPUT_DIR"
echo "     embodimentTag = NEW_EMBODIMENT"
echo "   (base action head is UNTRAINED → ~0% baseline before fine-tuning)"
