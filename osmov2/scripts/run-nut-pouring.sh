#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws curl git jq kubectl osmo tar terraform

OSMO_COOKBOOK_REF="${OSMO_COOKBOOK_REF:-$(version_value cookbook_ref)}"
NUT_POURING_COSMOS_TRANSFER_REF="${NUT_POURING_COSMOS_TRANSFER_REF:-$(version_value cosmos_transfer_ref)}"
NUT_POURING_COSMOS_PREDICT_TOKENIZER_REVISION="${NUT_POURING_COSMOS_PREDICT_TOKENIZER_REVISION:-$(version_value cosmos_predict_tokenizer_revision)}"
OSMO_GPU_PLATFORM_NAME="${OSMO_GPU_PLATFORM_NAME:-g7e-rtx-pro-6000}"
NUT_POURING_POOL="${NUT_POURING_POOL:-default}"
NUT_POURING_WORK_DIR="${NUT_POURING_WORK_DIR:-$(mktemp -d)}"
NUT_POURING_KEEP_WORK_DIR="${NUT_POURING_KEEP_WORK_DIR:-false}"
NUT_POURING_INPUT_DATASET="${NUT_POURING_INPUT_DATASET:-PhysAI-InputMimic}"
NUT_POURING_DATASET_BUCKET="${NUT_POURING_DATASET_BUCKET:-aws-osmo}"
NUT_POURING_DATASET_URL="${NUT_POURING_DATASET_URL:-https://download.isaacsim.omniverse.nvidia.com/isaaclab/dataset/dataset_annotated_gr1_nut_pouring.hdf5}"
NUT_POURING_SKIP_DATASET_UPLOAD="${NUT_POURING_SKIP_DATASET_UPLOAD:-false}"
HF_TOKEN_FILE="${HF_TOKEN_FILE:-}"
NUT_POURING_PREWARM_GPU_NODE="${NUT_POURING_PREWARM_GPU_NODE:-true}"
NUT_POURING_PREWARM_INSTANCE_TYPE="${NUT_POURING_PREWARM_INSTANCE_TYPE:-g7e.24xlarge}"
NUT_POURING_RETAIN_PREWARM_POD="${NUT_POURING_RETAIN_PREWARM_POD:-false}"
NUT_POURING_VERIFY_GPU_CLEANUP="${NUT_POURING_VERIFY_GPU_CLEANUP:-true}"
NUT_POURING_CAPACITY_WAIT_ATTEMPTS="${NUT_POURING_CAPACITY_WAIT_ATTEMPTS:-90}"
NUT_POURING_CAPACITY_WAIT_SECONDS="${NUT_POURING_CAPACITY_WAIT_SECONDS:-10}"
NUT_POURING_REQUIRED_CPU="${NUT_POURING_REQUIRED_CPU:-64}"
NUT_POURING_REQUIRED_MEMORY_GI="${NUT_POURING_REQUIRED_MEMORY_GI:-512}"
NUT_POURING_REQUIRED_GPU="${NUT_POURING_REQUIRED_GPU:-1}"
NUT_POURING_EPHEMERAL_STORAGE="${NUT_POURING_EPHEMERAL_STORAGE-200Gi}"
NUT_POURING_CUDA_ARCH_LIST="${NUT_POURING_CUDA_ARCH_LIST:-12.0}"
NUT_POURING_MAX_DEMOS="${NUT_POURING_MAX_DEMOS:-}"
NUT_POURING_START_STEP="${NUT_POURING_START_STEP:-1}"
NUT_POURING_WAIT_ATTEMPTS="${NUT_POURING_WAIT_ATTEMPTS:-4320}"
NUT_POURING_WAIT_SECONDS="${NUT_POURING_WAIT_SECONDS:-60}"
NUT_POURING_LOG_LINES="${NUT_POURING_LOG_LINES:-200}"
NUT_POURING_GPU_METRICS_INTERVAL_SECONDS="${NUT_POURING_GPU_METRICS_INTERVAL_SECONDS:-10}"
NUT_POURING_PREPARED_WORKFLOWS_DIR="${NUT_POURING_PREPARED_WORKFLOWS_DIR:-}"
NUT_POURING_PREPARE_ONLY="${NUT_POURING_PREPARE_ONLY:-false}"
HF_TOKEN_PAYLOAD_FILE=""

WORKFLOWS=(
  01_mimic_generation.yaml
  02_hdf5_to_mp4.yaml
  03_cosmos_augmentation.yaml
  04_mp4_to_hdf5.yaml
  05_lerobot_conversion.yaml
  06_groot_finetune.yaml
)

cleanup() {
  [[ -n "${HF_TOKEN_PAYLOAD_FILE}" ]] && rm -f "${HF_TOKEN_PAYLOAD_FILE}"
  if [[ "${NUT_POURING_KEEP_WORK_DIR}" != "true" ]]; then
    rm -rf "${NUT_POURING_WORK_DIR}"
  fi
  if [[ "${NUT_POURING_PREWARM_GPU_NODE}" == "true" && "${NUT_POURING_RETAIN_PREWARM_POD}" != "true" ]]; then
    kubectl -n "$(terraform_output osmo_workload_namespace)" delete pod aws-osmo-gpu-prewarm --ignore-not-found >/dev/null 2>&1 || true
  fi
  if [[ -n "${PORT_FORWARD_PID:-}" ]]; then
    kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

hf_token() {
  if [[ -n "${HF_TOKEN:-}" ]]; then
    printf '%s' "${HF_TOKEN}"
    return 0
  fi
  if [[ -n "${HUGGING_FACE_HUB_TOKEN:-}" ]]; then
    printf '%s' "${HUGGING_FACE_HUB_TOKEN}"
    return 0
  fi
  if [[ -n "${HF_TOKEN_FILE}" && -r "${HF_TOKEN_FILE}" ]]; then
    tr -d '[:space:]' <"${HF_TOKEN_FILE}"
    return 0
  fi
  die "HF_TOKEN is required for the nut pouring workflow. Export HF_TOKEN or set HF_TOKEN_FILE to a readable token file."
}

workflow_id_from_submit() {
  jq -er '.name // .id // .workflow_id // .workflowId' 2>/dev/null || true
}

show_workflow_logs() {
  local workflow_id="$1"

  osmo workflow logs "${workflow_id}" 2>/dev/null | tail -n "${NUT_POURING_LOG_LINES}" || true
}

wait_workflow() {
  local workflow_id="$1"
  local query_output status

  for _ in $(seq 1 "${NUT_POURING_WAIT_ATTEMPTS}"); do
    query_output="$(osmo workflow query "${workflow_id}" 2>/dev/null || true)"
    status="$(printf '%s' "${query_output}" | awk -F: '/Status/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}')"
    case "${status}" in
      COMPLETED)
        show_workflow_logs "${workflow_id}"
        return 0
        ;;
      FAILED|FAILED_*|CANCELED|CANCELLED)
        printf '%s\n' "${query_output}" >&2
        show_workflow_logs "${workflow_id}" >&2
        die "nut pouring workflow ${workflow_id} ended with status ${status}"
        ;;
    esac
    sleep "${NUT_POURING_WAIT_SECONDS}"
  done

  osmo workflow query "${workflow_id}" || true
  die "nut pouring workflow did not complete before timeout: ${workflow_id}"
}

submit_and_wait() {
  local workflow_file="$1"
  local expected_dataset="${2:-}"
  local start_epoch end_epoch submit_output workflow_id

  log "submitting $(basename "${workflow_file}")"
  start_epoch="$(date -u +%s)"
  if ! submit_output="$(osmo workflow submit "${workflow_file}" --pool "${NUT_POURING_POOL}" -t json 2>/tmp/osmo-nut-pouring-submit.err)"; then
    cat /tmp/osmo-nut-pouring-submit.err >&2
    die "failed to submit $(basename "${workflow_file}")"
  fi

  workflow_id="$(printf '%s' "${submit_output}" | workflow_id_from_submit)"
  [[ -n "${workflow_id}" && "${workflow_id}" != "null" ]] || {
    printf '%s\n' "${submit_output}" >&2
    die "could not determine workflow ID for $(basename "${workflow_file}")"
  }

  printf '%s\t%s\n' "$(basename "${workflow_file}")" "${workflow_id}" | tee -a "${NUT_POURING_WORK_DIR}/workflow-ids.tsv"
  wait_workflow "${workflow_id}"
  end_epoch="$(date -u +%s)"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(basename "${workflow_file}")" \
    "${workflow_id}" \
    "${start_epoch}" \
    "${end_epoch}" \
    "$((end_epoch - start_epoch))" >>"${NUT_POURING_WORK_DIR}/workflow-runtimes.tsv"
  if [[ -n "${expected_dataset}" ]]; then
    verify_dataset_ready "${expected_dataset}"
  fi
  log "completed $(basename "${workflow_file}"): ${workflow_id}"
}

expected_output_dataset() {
  case "$1" in
    01_mimic_generation.yaml) printf '%s\n' "PhysAI-MimicGen" ;;
    02_hdf5_to_mp4.yaml) printf '%s\n' "PhysAI-MP4Videos" ;;
    03_cosmos_augmentation.yaml) printf '%s\n' "PhysAI-CosmosAugmentedMP4" ;;
    04_mp4_to_hdf5.yaml) printf '%s\n' "PhysAI-CosmosAugmentedHDF5" ;;
    05_lerobot_conversion.yaml) printf '%s\n' "PhysAI-LeRobotDataset" ;;
    06_groot_finetune.yaml) printf '%s\n' "PhysAI-GR00T-Finetuned" ;;
  esac
}

verify_dataset_ready() {
  local dataset_name="$1"
  local dataset_json

  log "verifying output dataset ${dataset_name}"
  dataset_json="$(osmo dataset info "${dataset_name}" -t json 2>/dev/null || true)"
  if ! printf '%s' "${dataset_json}" | jq -e '
      any(.versions[]?; .status == "READY" and ((.size // 0) | tonumber) > 0)
    ' >/dev/null; then
    printf '%s\n' "${dataset_json}" >&2
    die "expected output dataset is missing or empty: ${dataset_name}"
  fi
}

set_osmo_credential() {
  local credential_name="$1"
  shift

  osmo credential delete "${credential_name}" >/dev/null 2>&1 || true
  osmo credential set "${credential_name}" "$@" >/dev/null
}

add_platform_to_workflow() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk -v platform="${OSMO_GPU_PLATFORM_NAME}" '
    /^  resources:[[:space:]]*$/ {
      in_resources = 1
      print
      next
    }
    in_resources && /^  [^[:space:]]/ {
      in_resources = 0
    }
    in_resources && /^    [A-Za-z0-9_.-]+:[[:space:]]*$/ {
      print
      print "      platform: " platform
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

remove_interactive_holds() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /Starting interactive session for inspection/ { next }
    /^[[:space:]]*sleep infinity[[:space:]]*$/ { next }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

normalize_dataset_shorthand() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /^[[:space:]]*- dataset:[[:space:]]*/ {
      indent = $0
      sub(/- dataset:.*/, "", indent)
      value = $0
      sub(/^[[:space:]]*- dataset:[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      print indent "- dataset:"
      print indent "    name: " value
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

normalize_input_dataset_paths() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk -v input_dataset="${NUT_POURING_INPUT_DATASET}" '
    {
      gsub("/osmo/data/input/0/input_mimic/", "/osmo/data/input/0/" input_dataset "/")
      gsub("/input_mimic/", "/" input_dataset "/")
      print
    }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

normalize_mp4_dataset_paths() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk -v max_demos="${NUT_POURING_MAX_DEMOS}" '
    /# Loop through all demo MP4 files \(RGB videos only, not depth\)/ {
      print
      print "          MP4_LIST_FILE=$(mktemp)"
      print "          find {{input:0}} -type f -name \"demo_*_robot_pov_cam.mp4\" ! -name \"*_depth.mp4\" ! -name \"*_normals.mp4\" ! -name \"*_segmentation.mp4\" | sort > \"$MP4_LIST_FILE\""
      if (max_demos != "") {
        print "          echo \"Limiting Cosmos augmentation to " max_demos " RGB MP4 files\""
        print "          head -n " max_demos " \"$MP4_LIST_FILE\" > \"${MP4_LIST_FILE}.limited\""
        print "          mv \"${MP4_LIST_FILE}.limited\" \"$MP4_LIST_FILE\""
      }
      print "          MP4_COUNT=$(wc -l < \"$MP4_LIST_FILE\")"
      print "          echo \"RGB MP4 file count: $MP4_COUNT\""
      print "          if [ \"$MP4_COUNT\" -eq 0 ]; then"
      print "              echo \"No RGB MP4 files found under {{input:0}}\" >&2"
      print "              find {{input:0}} -maxdepth 3 -type f | head -n 50"
      print "              exit 1"
      print "          fi"
      next
    }
    /^[[:space:]]*for mp4_file in \{\{input:0\}\}\/demo_\*_robot_pov_cam\.mp4; do[[:space:]]*$/ {
      indent = $0
      sub(/for mp4_file.*/, "", indent)
      print indent "while IFS= read -r mp4_file; do"
      next
    }
    /^[[:space:]]*demo_name=\$\(basename "\$mp4_file" \.mp4\)[[:space:]]*$/ {
      print
      indent = $0
      sub(/demo_name.*/, "", indent)
      print indent "mp4_dir=$(dirname \"$mp4_file\")"
      next
    }
    /\{\{input:0\}\}\/\$\{demo_name\}_depth\.mp4/ {
      gsub(/\{\{input:0\}\}\/\$\{demo_name\}_depth\.mp4/, "${mp4_dir}/${demo_name}_depth.mp4")
      print
      next
    }
    /^[[:space:]]*python \/workspace\/cosmos-transfer2\.5\/examples\/inference\.py \\/ {
      in_inference = 1
      print
      next
    }
    /[|][|] echo "Warning: Processing failed for \$demo_name"/ {
      next
    }
    in_inference && /-o \/workspace\/cosmos-transfer2\.5\/outputs \\/ {
      sub(/[[:space:]]*\\[[:space:]]*$/, "")
      print
      in_inference = 0
      next
    }
    /cp -r \/workspace\/cosmos-transfer2\.5\/outputs\/\* \{\{output\}\}\/\$\{demo_name\}\// {
      print
      indent = $0
      sub(/cp -r.*/, "", indent)
      print indent "if [ -f /workspace/cosmos-transfer2.5/outputs/robot_depth.mp4 ]; then"
      print indent "    cp /workspace/cosmos-transfer2.5/outputs/robot_depth.mp4 {{output}}/${demo_name}.mp4"
      print indent "fi"
      next
    }
    /^[[:space:]]*done[[:space:]]*$/ {
      indent = $0
      sub(/done.*/, "", indent)
      print indent "done < \"$MP4_LIST_FILE\""
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

normalize_augmented_mp4_dataset_paths() {
  local workflow_file="$1"
  local gr1_converter="${ROOT_DIR}/scripts/nut-pouring-gr1-mp4-to-hdf5.py"
  local temp_file
  temp_file="$(mktemp)"

  [[ -r "${gr1_converter}" ]] || die "missing GR1 MP4 to HDF5 helper: ${gr1_converter}"

  awk '
    function emit_gr1_converter(indent) {
      while ((getline line < gr1_converter) > 0) {
        print indent line
      }
      close(gr1_converter)
    }
    /echo "=== Convert augmented MP4 back to HDF5 ==="/ {
      print
      indent = $0
      sub(/echo.*/, "", indent)
      print indent "AUGMENTED_VIDEOS_DIR=/tmp/cosmos_augmented_mp4_flat"
      print indent "rm -rf \"$AUGMENTED_VIDEOS_DIR\""
      print indent "mkdir -p \"$AUGMENTED_VIDEOS_DIR\""
      print indent "find {{input:1}} -type f -name \"demo_*.mp4\" \\"
      print indent "  ! -name \"*_depth.mp4\" \\"
      print indent "  ! -name \"*_normals.mp4\" \\"
      print indent "  ! -name \"*_segmentation.mp4\" \\"
      print indent "  ! -name \"*control_depth.mp4\" \\"
      print indent "  -exec cp {} \"$AUGMENTED_VIDEOS_DIR\" \\;"
      print indent "while IFS= read -r generated_mp4; do"
      print indent "  demo_name=$(basename \"$(dirname \"$generated_mp4\")\")"
      print indent "  if [[ \"$demo_name\" == demo_* ]]; then"
      print indent "    cp \"$generated_mp4\" \"$AUGMENTED_VIDEOS_DIR/${demo_name}.mp4\""
      print indent "  fi"
      print indent "done < <(find {{input:1}} -type f -name \"robot_depth.mp4\" | sort)"
      print indent "AUGMENTED_VIDEO_COUNT=$(find \"$AUGMENTED_VIDEOS_DIR\" -maxdepth 1 -type f -name \"demo_*.mp4\" | wc -l)"
      print indent "echo \"Flattened augmented MP4 file count: $AUGMENTED_VIDEO_COUNT\""
      print indent "find \"$AUGMENTED_VIDEOS_DIR\" -maxdepth 1 -type f -name \"demo_*.mp4\" | sort | head -20"
      print indent "if [ \"$AUGMENTED_VIDEO_COUNT\" -eq 0 ]; then"
      print indent "  echo \"No augmented MP4 files found under {{input:1}}\" >&2"
      print indent "  find {{input:1}} -maxdepth 5 -type f | sort | head -100"
      print indent "  exit 1"
      print indent "fi"
      next
    }
    /\/workspace\/isaaclab\/_isaac_sim\/python\.sh scripts\/tools\/mp4_to_hdf5\.py \\/ {
      indent = $0
      sub(/\/workspace.*/, "", indent)
      print indent "/workspace/isaaclab/_isaac_sim/python.sh - \"$INPUT_HDF5\" \"$AUGMENTED_VIDEOS_DIR\" \"{{output}}/cosmos_augmented_dataset.hdf5\" <<'PY_GR1_MP4_TO_HDF5'"
      emit_gr1_converter(indent)
      print indent "PY_GR1_MP4_TO_HDF5"
      skip_converter_args = 3
      next
    }
    skip_converter_args > 0 {
      skip_converter_args--
      next
    }
    /--videos_dir \{\{input:1\}\}/ {
      indent = $0
      sub(/--videos_dir.*/, "", indent)
      print indent "--videos_dir \"$AUGMENTED_VIDEOS_DIR\" \\"
      next
    }
    { print }
  ' gr1_converter="${gr1_converter}" "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

repair_lerobot_conversion_pip() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /echo "Verified Isaac-GR00T"/ {
      print
      indent = $0
      sub(/echo.*/, "", indent)
      print indent "# Isaac-GR00T dependency resolution can leave Isaac Lab pip vendor files inconsistent."
      print indent "ISAACLAB_PYTHON_BIN=\"$(isaaclab_python -c '\''import sys; print(sys.executable)'\'' | tail -n 1)\""
      print indent "echo \"Isaac Lab Python: ${ISAACLAB_PYTHON_BIN}\""
      print indent "\"${ISAACLAB_PYTHON_BIN}\" - <<'\''PY_REPAIR_PIP'\''"
      print indent "import ensurepip"
      print indent "import os"
      print indent "import shutil"
      print indent "import site"
      print indent ""
      print indent "removed = []"
      print indent "site_paths = list(site.getsitepackages())"
      print indent "try:"
      print indent "    site_paths.append(site.getusersitepackages())"
      print indent "except Exception:"
      print indent "    pass"
      print indent "for base in dict.fromkeys(site_paths):"
      print indent "    if not base or not os.path.isdir(base):"
      print indent "        continue"
      print indent "    for name in os.listdir(base):"
      print indent "        if name == \"pip\" or name.startswith(\"pip-\"):"
      print indent "            path = os.path.join(base, name)"
      print indent "            if os.path.isdir(path):"
      print indent "                shutil.rmtree(path)"
      print indent "            else:"
      print indent "                os.remove(path)"
      print indent "            removed.append(path)"
      print indent "print(\"Removed pip install paths:\", removed)"
      print indent "ensurepip.bootstrap(upgrade=True, default_pip=True)"
      print indent "PY_REPAIR_PIP"
      print indent "\"${ISAACLAB_PYTHON_BIN}\" -m pip --version"
      print indent "\"${ISAACLAB_PYTHON_BIN}\" -m pip install --force-reinstall --no-cache-dir \"packaging<24\""
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

protect_hf_token_logging() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    skip_next {
      skip_next = 0
      next
    }
    /git config --global credential\.helper store && huggingface-cli login[[:space:]]*\\/ {
      indent = $0
      sub(/git config.*/, "", indent)
      print indent "set +x"
      print indent "git config --global credential.helper store"
      print indent "huggingface-cli login --token \"$HF_TOKEN\" --add-to-git-credential"
      print indent "set -x"
      skip_next = 1
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

set_torch_cuda_arch_list() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk -v arch_list="${NUT_POURING_CUDA_ARCH_LIST}" '
    !inserted && /^[[:space:]]*set -e/ {
      print
      indent = $0
      sub(/set -e.*/, "", indent)
      print indent "export TORCH_CUDA_ARCH_LIST=\"" arch_list "\""
      inserted = 1
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

normalize_groot_input_dataset_path() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /echo "Running GR00T finetuning with single GPU..."/ {
      print
      indent = $0
      sub(/echo.*/, "", indent)
      print indent "DATASET_PATH=$(find {{input:0}} -type d -path \"*/nut_pouring_task/lerobot\" | sort | head -n 1)"
      print indent "if [ -z \"${DATASET_PATH}\" ]; then"
      print indent "  echo \"Could not find nut_pouring_task/lerobot under {{input:0}}\" >&2"
      print indent "  find {{input:0}} -maxdepth 5 -type d | sort >&2"
      print indent "  exit 1"
      print indent "fi"
      print indent "echo \"Using LeRobot dataset path: ${DATASET_PATH}\""
      next
    }
    /--dataset-path \{\{input:0\}\}\/nut_pouring_task\/lerobot[[:space:]]*\\/ {
      indent = $0
      sub(/--dataset-path.*/, "", indent)
      print indent "--dataset-path \"${DATASET_PATH}\" \\"
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

patch_groot_blackwell_torch_install() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /pip install --force-reinstall torch==2\.5\.1 torchvision==0\.20\.1 torchaudio==2\.5\.1 numpy==1\.26\.4/ {
      indent = $0
      sub(/pip install.*/, "", indent)
      print indent "GPU_COMPUTE_CAPS=\"$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null || true)\""
      print indent "if echo \"${GPU_COMPUTE_CAPS}\" | awk '\''($1 + 0) >= 12.0 { found = 1 } END { exit found ? 0 : 1 }'\''; then"
      print indent "  echo \"Detected Blackwell-class GPU (${GPU_COMPUTE_CAPS}); installing PyTorch CUDA 12.8 wheels for sm_120 support\""
      print indent "  pip install --force-reinstall --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio"
      print indent "  pip install --force-reinstall numpy==1.26.4"
      print indent "  pip install --force-reinstall --no-build-isolation --no-cache-dir --no-deps flash_attn==2.8.3"
      print indent "else"
      print indent "  pip install --force-reinstall torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 numpy==1.26.4"
      print indent "fi"
      print indent "python -c '\''import torch; print(\"torch\", torch.__version__); print(\"torch_cuda\", torch.version.cuda); print(\"torch_arch_list\", torch.cuda.get_arch_list() if torch.cuda.is_available() else [])'\''"
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

patch_groot_blackwell_attention_fallback() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk '
    /git checkout 796ca8d87360913c47e9f75e17c11d63f7805048/ {
      print
      indent = $0
      sub(/git checkout.*/, "", indent)
      print ""
      print "          GPU_COMPUTE_CAPS=\"$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null || true)\""
      print "          if echo \"${GPU_COMPUTE_CAPS}\" | awk '\''($1 + 0) >= 12.0 { found = 1 } END { exit found ? 0 : 1 }'\''; then"
      print "            echo \"Patching Eagle attention fallback for Blackwell (${GPU_COMPUTE_CAPS})\""
      print "            export GR00T_DISABLE_FLASH_ATTN=1"
      print "            export GR00T_EAGLE_ATTN_IMPLEMENTATION=sdpa"
      print "            python - <<'\''PY_EAGLE_ATTENTION_PATCH'\''"
      print "          import json"
      print "          from pathlib import Path"
      print ""
      print "          attention_impl = \"sdpa\""
      print ""
      print "          config_path = Path(\"gr00t/model/backbone/eagle2_hg_model/config.json\")"
      print "          config = json.loads(config_path.read_text())"
      print "          config[\"_attn_implementation\"] = attention_impl"
      print "          for key in (\"vision_config\", \"text_config\"):"
      print "              if isinstance(config.get(key), dict):"
      print "                  config[key][\"_attn_implementation\"] = attention_impl"
      print "                  config[key][\"_attn_implementation_autoset\"] = False"
      print "          config_path.write_text(json.dumps(config, indent=2) + \"\\n\")"
      print ""
      print "          backbone_path = Path(\"gr00t/model/backbone/eagle_backbone.py\")"
      print "          backbone = backbone_path.read_text()"
      print "          old = \"config = AutoConfig.from_pretrained(DEFAULT_EAGLE_PATH, trust_remote_code=True)\\n        self.eagle_model = AutoModel.from_config(config, trust_remote_code=True)\""
      print "          new = \"config = AutoConfig.from_pretrained(DEFAULT_EAGLE_PATH, trust_remote_code=True)\\n        attention_impl = os.environ.get(\\\"GR00T_EAGLE_ATTN_IMPLEMENTATION\\\", \\\"sdpa\\\")\\n        config._attn_implementation = attention_impl\\n        if hasattr(config, \\\"vision_config\\\"):\\n            config.vision_config._attn_implementation = attention_impl\\n        if hasattr(config, \\\"text_config\\\"):\\n            config.text_config._attn_implementation = attention_impl\\n        self.eagle_model = AutoModel.from_config(config, trust_remote_code=True)\""
      print "          if old not in backbone:"
      print "              raise SystemExit(\"Could not patch eagle_backbone attention config\")"
      print "          backbone_path.write_text(backbone.replace(old, new))"
      print ""
      print "          modeling_path = Path(\"gr00t/model/backbone/eagle2_hg_model/modeling_eagle2_5_vl.py\")"
      print "          modeling = modeling_path.read_text()"
      print "          modeling = modeling.replace("
      print "              \"config.vision_config._attn_implementation = \\\"flash_attention_2\\\"\","
      print "              \"config.vision_config._attn_implementation = \\\"sdpa\\\"\","
      print "          )"
      print "          old = \"\"\"assert (\\n                    config.text_config._attn_implementation == \\\"flash_attention_2\\\"\\n                ), f\\\"Qwen2 must use flash_attention_2 but got {config.text_config._attn_implementation}\\\"\\n                self.language_model = Qwen2ForCausalLM(config.text_config)\"\"\""
      print "          new = \"\"\"config.text_config._attn_implementation = \\\"sdpa\\\"\\n                self.language_model = Qwen2ForCausalLM(config.text_config)\"\"\""
      print "          if old not in modeling:"
      print "              raise SystemExit(\"Could not patch Qwen2 attention assertion\")"
      print "          modeling_path.write_text(modeling.replace(old, new))"
      print ""
      print "          radio_path = Path(\"gr00t/model/backbone/eagle2_hg_model/radio_model.py\")"
      print "          radio = radio_path.read_text()"
      print "          if \"import os\\n\" not in radio:"
      print "              radio = radio.replace(\"import copy\\n\", \"import copy\\nimport os\\n\")"
      print "          old = \"replace_vit_attn_with_flash_attn()\\n####\""
      print "          new = \"if os.environ.get(\\\"GR00T_DISABLE_FLASH_ATTN\\\", \\\"0\\\") != \\\"1\\\":\\n    replace_vit_attn_with_flash_attn()\\n####\""
      print "          if old not in radio:"
      print "              raise SystemExit(\"Could not patch RADIO flash attention hook\")"
      print "          radio_path.write_text(radio.replace(old, new))"
      print "          PY_EAGLE_ATTENTION_PATCH"
      print "          fi"
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

inject_groot_training_artifacts() {
  local workflow_file="$1"
  local artifact_helper="${ROOT_DIR}/scripts/nut-pouring-artifacts.py"
  local temp_file
  temp_file="$(mktemp)"

  [[ -r "${artifact_helper}" ]] || die "missing artifact helper: ${artifact_helper}"

  awk \
    -v interval="${NUT_POURING_GPU_METRICS_INTERVAL_SECONDS}" \
    -v artifact_helper="${artifact_helper}" '
    function emit_helper(indent) {
      while ((getline line < artifact_helper) > 0) {
        print indent line
      }
      close(artifact_helper)
    }
    /pip install gpustat wandb==0\.19\.0/ {
      if ($0 !~ /matplotlib/) {
        gsub(/pip install gpustat wandb==0\.19\.0/, "pip install gpustat wandb==0.19.0 matplotlib tensorboard")
      }
      print
      next
    }
    !metrics_inserted && /^[[:space:]]*nvidia-smi[[:space:]]*$/ {
      print
      indent = $0
      sub(/nvidia-smi.*/, "", indent)
      print indent "START_TS=\"$(date -u +%s)\""
      print indent "GPU_METRICS_DIR=/tmp/nut-pouring-gpu-metrics"
      print indent "GPU_METRICS_CSV=\"${GPU_METRICS_DIR}/nvidia-smi.csv\""
      print indent "mkdir -p \"${GPU_METRICS_DIR}\""
      print indent "("
      print indent "  set +e"
      print indent "  while true; do"
      print indent "    nvidia-smi --query-gpu=timestamp,index,name,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu --format=csv,noheader,nounits >>\"${GPU_METRICS_CSV}\" 2>/dev/null || true"
      print indent "    sleep \"" interval "\""
      print indent "  done"
      print indent ") &"
      print indent "GPU_METRICS_PID=\"$!\""
      print indent "stop_gpu_metrics() {"
      print indent "  if [ -n \"${GPU_METRICS_PID:-}\" ]; then"
      print indent "    kill \"${GPU_METRICS_PID}\" >/dev/null 2>&1 || true"
      print indent "    wait \"${GPU_METRICS_PID}\" >/dev/null 2>&1 || true"
      print indent "    GPU_METRICS_PID=\"\""
      print indent "  fi"
      print indent "}"
      print indent "trap stop_gpu_metrics EXIT"
      metrics_inserted = 1
      next
    }
    /^[[:space:]]*python scripts\/gr00t_finetune\.py \\/ {
      indent = $0
      sub(/python.*/, "", indent)
      print indent "set +e"
      print
      in_train = 1
      next
    }
    in_train && /--embodiment-tag gr1[[:space:]]*$/ {
      print
      indent = $0
      sub(/--embodiment.*/, "", indent)
      block_indent = indent
      sub(/    $/, "", block_indent)
      print indent "TRAIN_EXIT=$?"
      print indent "set -e"
      print indent "stop_gpu_metrics"
      print indent "END_TS=\"$(date -u +%s)\""
      print indent "mkdir -p \"${OUTPUT_DIR}/gpu-metrics\""
      print indent "cp \"${GPU_METRICS_CSV}\" \"${OUTPUT_DIR}/gpu-metrics/nvidia-smi.csv\" 2>/dev/null || true"
      print indent "python - \"${GPU_METRICS_CSV}\" \"${OUTPUT_DIR}\" <<'PY_ARTIFACTS'"
      emit_helper(block_indent)
      print block_indent "PY_ARTIFACTS"
      print indent "cat > \"${OUTPUT_DIR}/run-manifest.json\" <<JSON"
      print block_indent "{"
      print block_indent "  \"workflow\": \"groot_finetune_nut_pouring\","
      print block_indent "  \"output_dataset\": \"{{ output_dataset }}\","
      print block_indent "  \"input_dataset\": \"{{ input_dataset }}\","
      print block_indent "  \"base_model_path\": \"nvidia/GR00T-N1.5-3B\","
      print block_indent "  \"max_steps\": 10000,"
      print block_indent "  \"save_steps\": 1000,"
      print block_indent "  \"gpu_metrics_interval_seconds\": " interval ","
      print block_indent "  \"retain_checkpoints\": true,"
      print block_indent "  \"runtime_seconds\": $((END_TS - START_TS)),"
      print block_indent "  \"train_exit\": ${TRAIN_EXIT}"
      print block_indent "}"
      print block_indent "JSON"
      print indent "find \"${OUTPUT_DIR}\" -maxdepth 5 -type f | sort | head -200"
      print indent "exit \"${TRAIN_EXIT}\""
      in_train = 0
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

pin_cosmos_transfer_ref() {
  local workflow_file="$1"
  local temp_file
  temp_file="$(mktemp)"

  awk \
    -v cosmos_ref="${NUT_POURING_COSMOS_TRANSFER_REF}" \
    -v tokenizer_ref="${NUT_POURING_COSMOS_PREDICT_TOKENIZER_REVISION}" '
    /git clone https:\/\/github.com\/nvidia-cosmos\/cosmos-transfer2\.5\.git/ {
      gsub(/git checkout [0-9a-f]+/, "git checkout " cosmos_ref)
      indent = $0
      sub(/git clone.*/, "", indent)
      print
      print indent "grep -q \"6787e176dce74a101d922174a95dba29fa5f0c55\" cosmos_transfer2/_src/imaginaire/utils/checkpoint_db.py"
      print indent "sed -i \"s/6787e176dce74a101d922174a95dba29fa5f0c55/" tokenizer_ref "/g\" cosmos_transfer2/_src/imaginaire/utils/checkpoint_db.py"
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

set_ephemeral_storage() {
  local workflow_file="$1"
  local temp_file

  [[ -n "${NUT_POURING_EPHEMERAL_STORAGE}" ]] || return 0

  temp_file="$(mktemp)"
  awk -v storage="${NUT_POURING_EPHEMERAL_STORAGE}" '
    /^[[:space:]]*storage:[[:space:]]*/ {
      indent = $0
      sub(/storage:.*/, "", indent)
      print indent "storage: " storage
      next
    }
    { print }
  ' "${workflow_file}" >"${temp_file}"

  mv "${temp_file}" "${workflow_file}"
}

wait_osmo_gpu_capacity() {
  local ready=""

  for _ in $(seq 1 "${NUT_POURING_CAPACITY_WAIT_ATTEMPTS}"); do
    ready="$(
      osmo resource list --pool "${NUT_POURING_POOL}" --platform "${OSMO_GPU_PLATFORM_NAME}" -t json 2>/dev/null | jq -er \
        --arg platform "${OSMO_GPU_PLATFORM_NAME}" \
        --argjson cpu "${NUT_POURING_REQUIRED_CPU}" \
        --argjson memory "${NUT_POURING_REQUIRED_MEMORY_GI}" \
        --argjson gpu "${NUT_POURING_REQUIRED_GPU}" \
        '.resources[]?
         | select(any(.["exposed_fields"]["pool/platform"][]?; test("/" + $platform + "$")))
         | select((.exposed_fields.cpu | tonumber) >= $cpu)
         | select((.exposed_fields.memory | tonumber) >= $memory)
         | select((.exposed_fields.gpu | tonumber) >= $gpu)
         | .hostname' | head -n 1
    )" || true

    if [[ -n "${ready}" ]]; then
      log "OSMO sees G7e capacity for nut pouring on ${ready}"
      return 0
    fi
    sleep "${NUT_POURING_CAPACITY_WAIT_SECONDS}"
  done

  osmo resource list --all || true
  die "OSMO did not observe G7e capacity for nut pouring before timeout"
}

configure_kubectl

AWS_REGION="$(terraform_output aws_region)"
OSMO_NAMESPACE="$(terraform_output osmo_namespace)"
OSMO_RUNTIME_SECRET_ARN="$(terraform_output osmo_runtime_secret_arn)"

SECRET_JSON="$(aws secretsmanager get-secret-value \
  --region "${AWS_REGION}" \
  --secret-id "${OSMO_RUNTIME_SECRET_ARN}" \
  --query SecretString \
  --output text)"
DEFAULT_ADMIN_TOKEN="$(printf '%s' "${SECRET_JSON}" | jq -er '.default_admin_token')"

kubectl -n "${OSMO_NAMESPACE}" port-forward svc/osmo-service 9000:80 >/tmp/osmo-nut-pouring-port-forward.log 2>&1 &
PORT_FORWARD_PID="$!"

for _ in $(seq 1 60); do
  if port_open 127.0.0.1 9000; then
    break
  fi
  sleep 2
done

port_open 127.0.0.1 9000 || die "OSMO service port-forward did not become ready"
login_osmo_with_token "http://127.0.0.1:9000" "${DEFAULT_ADMIN_TOKEN}" || die "failed to log in to OSMO"
osmo profile set bucket "${NUT_POURING_DATASET_BUCKET}" >/dev/null

load_ngc_api_key
log "setting OSMO NGC registry credential"
set_osmo_credential aws-osmo-ngc \
  --type REGISTRY \
  --payload registry=nvcr.io username="\$oauthtoken" auth="${NGC_API_KEY}"

log "setting OSMO Hugging Face generic credential"
HF_TOKEN_PAYLOAD_FILE="$(mktemp)"
chmod 600 "${HF_TOKEN_PAYLOAD_FILE}"
hf_token >"${HF_TOKEN_PAYLOAD_FILE}"
set_osmo_credential huggingface_token \
  --type GENERIC \
  --payload-file token="${HF_TOKEN_PAYLOAD_FILE}"
rm -f "${HF_TOKEN_PAYLOAD_FILE}"
HF_TOKEN_PAYLOAD_FILE=""

if [[ "${NUT_POURING_PREWARM_GPU_NODE}" == "true" ]]; then
  GPU_PREWARM_INSTANCE_TYPE="${NUT_POURING_PREWARM_INSTANCE_TYPE}" \
    "${ROOT_DIR}/scripts/prewarm-gpu-node.sh"
  wait_osmo_gpu_capacity
fi

mkdir -p "${NUT_POURING_WORK_DIR}"
SRC_DIR="${NUT_POURING_WORK_DIR}/OSMO"
git init "${SRC_DIR}" >/dev/null
git -C "${SRC_DIR}" fetch --depth 1 https://github.com/NVIDIA/OSMO.git "${OSMO_COOKBOOK_REF}" >/dev/null
git -C "${SRC_DIR}" checkout --detach FETCH_HEAD >/dev/null

COOKBOOK_DIR="${SRC_DIR}/cookbook/nut_pouring"
[[ -d "${COOKBOOK_DIR}" ]] || die "nut pouring cookbook was not found at ref ${OSMO_COOKBOOK_REF}"

log "targeting nut pouring workflows to OSMO platform ${OSMO_GPU_PLATFORM_NAME}"
if [[ -n "${NUT_POURING_EPHEMERAL_STORAGE}" ]]; then
  log "setting nut pouring ephemeral-storage to ${NUT_POURING_EPHEMERAL_STORAGE}"
fi
for workflow in "${WORKFLOWS[@]}"; do
  add_platform_to_workflow "${COOKBOOK_DIR}/${workflow}"
  normalize_dataset_shorthand "${COOKBOOK_DIR}/${workflow}"
  normalize_input_dataset_paths "${COOKBOOK_DIR}/${workflow}"
  set_ephemeral_storage "${COOKBOOK_DIR}/${workflow}"
done
normalize_mp4_dataset_paths "${COOKBOOK_DIR}/03_cosmos_augmentation.yaml"
normalize_augmented_mp4_dataset_paths "${COOKBOOK_DIR}/04_mp4_to_hdf5.yaml"
repair_lerobot_conversion_pip "${COOKBOOK_DIR}/05_lerobot_conversion.yaml"
protect_hf_token_logging "${COOKBOOK_DIR}/03_cosmos_augmentation.yaml"
set_torch_cuda_arch_list "${COOKBOOK_DIR}/03_cosmos_augmentation.yaml"
set_torch_cuda_arch_list "${COOKBOOK_DIR}/06_groot_finetune.yaml"
normalize_groot_input_dataset_path "${COOKBOOK_DIR}/06_groot_finetune.yaml"
patch_groot_blackwell_attention_fallback "${COOKBOOK_DIR}/06_groot_finetune.yaml"
patch_groot_blackwell_torch_install "${COOKBOOK_DIR}/06_groot_finetune.yaml"
pin_cosmos_transfer_ref "${COOKBOOK_DIR}/03_cosmos_augmentation.yaml"
inject_groot_training_artifacts "${COOKBOOK_DIR}/06_groot_finetune.yaml"
remove_interactive_holds "${COOKBOOK_DIR}/01_mimic_generation.yaml"

if [[ -n "${NUT_POURING_PREPARED_WORKFLOWS_DIR}" ]]; then
  log "writing prepared nut pouring workflows to ${NUT_POURING_PREPARED_WORKFLOWS_DIR}"
  mkdir -p "${NUT_POURING_PREPARED_WORKFLOWS_DIR}"
  cp "${COOKBOOK_DIR}/README.md" "${NUT_POURING_PREPARED_WORKFLOWS_DIR}/"
  cp "${COOKBOOK_DIR}/nutpour_gr1t2_base_env_cfg.py" "${NUT_POURING_PREPARED_WORKFLOWS_DIR}/"
  for workflow in "${WORKFLOWS[@]}"; do
    cp "${COOKBOOK_DIR}/${workflow}" "${NUT_POURING_PREPARED_WORKFLOWS_DIR}/"
  done
fi

if [[ "${NUT_POURING_PREPARE_ONLY}" == "true" ]]; then
  log "prepared nut pouring workflows only; skipping submission"
  exit 0
fi

if [[ "${NUT_POURING_SKIP_DATASET_UPLOAD}" != "true" ]]; then
  DATASET_FILE="${NUT_POURING_WORK_DIR}/dataset_annotated_gr1_nut_pouring.hdf5"
  log "downloading nut pouring input dataset"
  curl -fL --retry 3 -o "${DATASET_FILE}" "${NUT_POURING_DATASET_URL}"
  log "uploading input dataset ${NUT_POURING_INPUT_DATASET}"
  osmo dataset upload "${NUT_POURING_INPUT_DATASET}" "${DATASET_FILE}"
fi

if [[ "${NUT_POURING_START_STEP}" -le 1 ]]; then
  : >"${NUT_POURING_WORK_DIR}/workflow-ids.tsv"
  : >"${NUT_POURING_WORK_DIR}/workflow-runtimes.tsv"
else
  touch "${NUT_POURING_WORK_DIR}/workflow-ids.tsv"
  touch "${NUT_POURING_WORK_DIR}/workflow-runtimes.tsv"
fi

for workflow in "${WORKFLOWS[@]}"; do
  step="${workflow%%_*}"
  step_number="$((10#${step}))"
  if [[ "${step_number}" -lt "${NUT_POURING_START_STEP}" ]]; then
    log "skipping $(basename "${workflow}") because NUT_POURING_START_STEP=${NUT_POURING_START_STEP}"
    continue
  fi
  submit_and_wait "${COOKBOOK_DIR}/${workflow}" "$(expected_output_dataset "${workflow}")"
done

log "nut pouring workflow IDs"
cat "${NUT_POURING_WORK_DIR}/workflow-ids.tsv"

if [[ "${NUT_POURING_PREWARM_GPU_NODE}" == "true" && "${NUT_POURING_VERIFY_GPU_CLEANUP}" == "true" ]]; then
  log "verifying Karpenter GPU node cleanup"
  "${ROOT_DIR}/scripts/wait-gpu-node-cleanup.sh"
fi
