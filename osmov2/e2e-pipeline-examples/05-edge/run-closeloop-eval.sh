#!/bin/bash
# =============================================================================
# run-closeloop-eval.sh
# Stage 5 (edge) — Test the DEPLOYED edge model in LeIsaac closed-loop simulation.
#
# The edge inference component (com.aws.groot.inference) exposes a GR00T ZMQ
# policy server on the device (default :5555). This script runs LeIsaac's SO-101
# pick-orange closed-loop eval as a CLIENT against that server. So after you
# change the model and redeploy (see "Changing the model and redeploying" in
# README.md), you can immediately verify the NEW policy in simulation:
#
#     change model  ->  register-components.sh --deploy --model-s3-uri ...
#                    ->  (edge server reloads the new checkpoint on :5555)
#                    ->  bash run-closeloop-eval.sh        # drive the sim
#
# Run this on a machine with an NVIDIA GPU + the NVIDIA Container Toolkit and
# Docker (e.g. the same G6e/L40S host the edge server runs on). It reuses the
# isaac-lab container image — no local Isaac install needed.
#
# ── Fixes baked in (from end-to-end validation) ─────────────────────────────
#   1. NVIDIA_DRIVER_CAPABILITIES=all — RTX camera rendering needs the Vulkan
#      "graphics" capability. `--gpus all` alone grants only compute/utility, so
#      camera render fails with `vkGetMemoryFdKHR failed` / "Cannot create shared
#      handle" / "Failed to allocate 1280x720 LdrColor".
#   2. numpy pinned to <2 in the client packages. Isaac Sim ships numpy 1.x;
#      a numpy 2.x on PYTHONPATH shadows it and crashes Kit at startup with an
#      ABI segfault (right after the EULA banner). We remove any numpy 2.x from
#      the client dir so Isaac Sim's own numpy is used.
#   3. LeIsaac pinned to the eval-capable commit (has
#      scripts/evaluation/policy_inference.py + the N1.6 service policy client),
#      plus the N1.6 dynamic-language-key patch and the headless keyboard /
#      wait_for_textures patch.
#   4. torch/torchvision/nvidia-cu* pruned from the client dir so Isaac Sim's
#      bundled CUDA/torch is used (avoids nvJitLink/cusparse symbol clashes).
#   5. PYTHONUNBUFFERED=1 so episode/progress logs stream to the console.
#   6. A dedicated Isaac shader cache dir (faster reruns; must be fresh — a stale
#      cache from another Isaac version can crash Kit at startup).
#
# ⚠️ Note: this reuses the standalone leisaac closed-loop path (Stage 4 machinery)
# on the edge host. The intended/validated home for closed-loop eval is Stage 4
# (04-closeloop) run via OSMO, which provisions a matching environment. Running
# it on an arbitrary edge box can hit Isaac Sim / scene-asset environment issues
# (e.g. a stall during scene creation). If this stalls, prefer Stage 4 on OSMO.
#
# Usage:
#   bash run-closeloop-eval.sh [options]
#     --policy-host <H>     policy server host (default localhost; edge uses host net)
#     --policy-port <P>     policy server port (default 5555)
#     --task <T>            task id (default LeIsaac-SO101-PickOrange-v0)
#     --instruction <STR>   language instruction
#                           (default "pick up the orange and place it on the plate")
#     --eval-rounds <N>     number of episodes (default 5)
#     --isaac-image <IMG>   isaac-lab image (default nvcr.io/nvidia/isaac-lab:2.3.0)
#     --leisaac-repo <URL>  leisaac git repo (default https://github.com/LightwheelAI/leisaac)
#     --leisaac-ref <SHA>   leisaac commit (default 24d3bcd3f1e4585740fc79921782c41617237812)
#     --assets-root <DIR>   host dir with leisaac assets (robots/, scenes/); if
#                           missing, the v0.1.0 scene + SO-101 USD are downloaded
#     --work-dir <DIR>      host dir for repo/pkgs/cache (default ./.leisaac-eval)
#     --gui                 attempt a GUI window on $DISPLAY (needs X/DCV; unstable)
#     --setup-only          prepare deps/patches then exit (don't run the eval)
#     --force-setup         re-prepare deps/patches even if already present
#
# Examples:
#   # after redeploying a new model to the edge, verify it in sim:
#   bash run-closeloop-eval.sh --eval-rounds 5
#   # point at a server on another host/port:
#   bash run-closeloop-eval.sh --policy-host 10.0.0.5 --policy-port 5556
# =============================================================================
set -euo pipefail

POLICY_HOST="localhost"
POLICY_PORT="5555"
TASK="LeIsaac-SO101-PickOrange-v0"
INSTRUCTION="pick up the orange and place it on the plate"
EVAL_ROUNDS="5"
ISAAC_IMAGE="nvcr.io/nvidia/isaac-lab:2.3.0"
LEISAAC_REPO="https://github.com/LightwheelAI/leisaac"
LEISAAC_REF="24d3bcd3f1e4585740fc79921782c41617237812"
ASSETS_ROOT=""
WORK_DIR="$(pwd)/.leisaac-eval"
GUI="false"
SETUP_ONLY="false"
FORCE_SETUP="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --policy-host)  POLICY_HOST="$2"; shift 2 ;;
    --policy-port)  POLICY_PORT="$2"; shift 2 ;;
    --task)         TASK="$2"; shift 2 ;;
    --instruction)  INSTRUCTION="$2"; shift 2 ;;
    --eval-rounds)  EVAL_ROUNDS="$2"; shift 2 ;;
    --isaac-image)  ISAAC_IMAGE="$2"; shift 2 ;;
    --leisaac-repo) LEISAAC_REPO="$2"; shift 2 ;;
    --leisaac-ref)  LEISAAC_REF="$2"; shift 2 ;;
    --assets-root)  ASSETS_ROOT="$2"; shift 2 ;;
    --work-dir)     WORK_DIR="$2"; shift 2 ;;
    --gui)          GUI="true"; shift ;;
    --setup-only)   SETUP_ONLY="true"; shift ;;
    --force-setup)  FORCE_SETUP="true"; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found."; exit 1; }

REPO_DIR="${WORK_DIR}/leisaac"
PKGS_DIR="${WORK_DIR}/pkgs"
CACHE_DIR="${WORK_DIR}/cache"
ASSETS_DIR="${ASSETS_ROOT:-${WORK_DIR}/assets}"
MARKER="${PKGS_DIR}/.prepared"

mkdir -p "$WORK_DIR" "$PKGS_DIR" "$CACHE_DIR" "$ASSETS_DIR"

echo "============================================"
echo " LeIsaac closed-loop eval (edge model @ ${POLICY_HOST}:${POLICY_PORT})"
echo " Task:        $TASK"
echo " Instruction: $INSTRUCTION"
echo " Rounds:      $EVAL_ROUNDS"
echo " Isaac image: $ISAAC_IMAGE"
echo " LeIsaac ref: $LEISAAC_REF"
echo " Work dir:    $WORK_DIR"
echo "============================================"

# ─── Patch scripts (written to the work dir, applied inside the container) ───
cat > "${WORK_DIR}/patch_leisaac.py" <<'PYEOF'
# N1.6 dynamic language key + ModalityConfig deserialization (from run-isaaclab.sh).
import sys
policy_client, serialization = sys.argv[1], sys.argv[2]
try:
    with open(policy_client) as f:
        src = f.read()
    old = (
        '        super().__init__(host=host, port=port, timeout_ms=timeout_ms, ping_endpoint="ping")\n'
        '        self.camera_keys = camera_keys\n'
        '        self.modality_keys = modality_keys'
    )
    new = old + (
        '\n        try:\n'
        '            modality_config = self.call_endpoint("get_modality_config", requires_input=False)\n'
        '            self.language_key = modality_config["language"].modality_keys[0]\n'
        '        except Exception:\n'
        '            self.language_key = "annotation.human.action.task_description"'
    )
    old_lang = '"annotation.human.task_description": [[observation_dict["task_description"]]],'
    new_lang = 'self.language_key: [[observation_dict["task_description"]]],'
    if old in src and old_lang in src:
        src = src.replace(old, new).replace(old_lang, new_lang)
        with open(policy_client, "w") as f:
            f.write(src)
        print("Patch 1 applied: dynamic language key.")
    else:
        print("Patch 1: structure changed or already patched - skipping.")
except FileNotFoundError:
    print("Patch 1: %s not found - skipping." % policy_client)
try:
    with open(serialization) as f:
        src2 = f.read()
    patched = False
    model_old = 'class ModalityConfig(BaseModel):'
    model_new = 'class ModalityConfig(BaseModel):\n    model_config = {"extra": "ignore"}'
    if model_old in src2 and 'model_config' not in src2:
        src2 = src2.replace(model_old, model_new)
        patched = True
    decode_old = '            obj = ModalityConfig(**json.loads(obj["as_json"]))'
    decode_new = (
        '            as_json = obj["as_json"]\n'
        '            data = as_json if isinstance(as_json, dict) else json.loads(as_json)\n'
        '            obj = ModalityConfig(**data)'
    )
    if decode_old in src2:
        src2 = src2.replace(decode_old, decode_new)
        patched = True
    if patched:
        with open(serialization, "w") as f:
            f.write(src2)
        print("Patch 2 applied: ModalityConfig deserialization fixed.")
    else:
        print("Patch 2: already patched or structure changed - skipping.")
except FileNotFoundError:
    print("Patch 2: %s not found - skipping." % serialization)
PYEOF

cat > "${WORK_DIR}/patch_headless.py" <<'PYEOF'
# Headless keyboard tolerance + disable wait_for_textures (from run-isaaclab.sh).
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
old = (
    "        self._appwindow = omni.appwindow.get_default_app_window()\n"
    "        self._input = carb.input.acquire_input_interface()\n"
    "        self._keyboard = self._appwindow.get_keyboard()\n"
    "        self._keyboard_sub = self._input.subscribe_to_keyboard_events(\n"
    "            self._keyboard,\n"
    "            self._on_keyboard_event,\n"
    "        )"
)
new = (
    "        try:\n"
    "            self._appwindow = omni.appwindow.get_default_app_window()\n"
    "        except Exception:\n"
    "            self._appwindow = None\n"
    "        self._input = carb.input.acquire_input_interface()\n"
    "        if self._appwindow is not None:\n"
    "            self._keyboard = self._appwindow.get_keyboard()\n"
    "        else:\n"
    "            self._keyboard = None\n"
    "        if self._keyboard is not None:\n"
    "            self._keyboard_sub = self._input.subscribe_to_keyboard_events(\n"
    "                self._keyboard,\n"
    "                self._on_keyboard_event,\n"
    "            )\n"
    "        else:\n"
    "            self._keyboard_sub = None"
)
if old in src:
    src = src.replace(old, new)
    print("Patched policy_inference.py for headless keyboard support")
else:
    print("Keyboard patch: already patched or structure changed - skipping")
tex_old = "    env_cfg.recorders = None\n"
tex_new = (
    "    env_cfg.recorders = None\n"
    "    if hasattr(env_cfg, 'wait_for_textures'):\n"
    "        env_cfg.wait_for_textures = False\n"
)
if tex_old in src and "env_cfg.wait_for_textures = False" not in src:
    src = src.replace(tex_old, tex_new)
    print("Patched policy_inference.py to disable wait_for_textures")
else:
    print("wait_for_textures patch: already patched or structure changed - skipping")
with open(path, "w") as f:
    f.write(src)
PYEOF

# ─── Prepare: clone eval-capable leisaac, install client deps, prune, patch ──
if [ "$FORCE_SETUP" = "true" ] || [ ! -f "$MARKER" ]; then
  echo ">>> [prepare] cloning leisaac @ ${LEISAAC_REF}"
  rm -rf "$REPO_DIR"
  git clone -q "${LEISAAC_REPO}.git" "$REPO_DIR"
  ( cd "$REPO_DIR" && git checkout -q "$LEISAAC_REF" )

  if [ ! -f "$REPO_DIR/scripts/evaluation/policy_inference.py" ]; then
    echo "ERROR: this leisaac ref has no scripts/evaluation/policy_inference.py"
    echo "  (the closed-loop eval path needs the eval-capable commit)."
    exit 1
  fi

  # Download the SO-101 scene + robot USD if no assets dir was provided.
  if [ -z "$ASSETS_ROOT" ] && [ ! -f "$ASSETS_DIR/robots/so101_follower.usd" ]; then
    echo ">>> [prepare] downloading SO-101 scene + robot assets (v0.1.0)"
    mkdir -p "$ASSETS_DIR/scenes" "$ASSETS_DIR/robots"
    curl -fsSL -o /tmp/kitchen_with_orange.zip \
      "${LEISAAC_REPO}/releases/download/v0.1.0/kitchen_with_orange.zip"
    unzip -oq /tmp/kitchen_with_orange.zip -d "$ASSETS_DIR/scenes/" && rm -f /tmp/kitchen_with_orange.zip
    curl -fsSL -o "$ASSETS_DIR/robots/so101_follower.usd" \
      "${LEISAAC_REPO}/releases/download/v0.1.0/so101_follower.usd"
  fi

  echo ">>> [prepare] installing client deps into $PKGS_DIR (isaac python), then pruning"
  docker run --rm \
    --entrypoint bash \
    -e ACCEPT_EULA=Y -e OMNI_ENV_PRIVACY_CONSENT=Y \
    -v "$PKGS_DIR":/pkgs -v "$REPO_DIR":/repo -v "$WORK_DIR":/work \
    "$ISAAC_IMAGE" -lc '
      set -e
      /workspace/isaaclab/_isaac_sim/python.sh -m pip install --target /pkgs \
        zmq msgpack-python lerobot ninja packaging /repo/source/leisaac
      # numpy 2.x crashes Isaac Sim (numpy 1.x) at Kit startup -> remove it.
      rm -rf /pkgs/numpy /pkgs/numpy-*.dist-info /pkgs/numpy.libs || true
      # Isaac Sim ships its own torch/CUDA -> remove clashing copies from /pkgs.
      rm -rf /pkgs/torch /pkgs/torch-*.dist-info /pkgs/torchvision /pkgs/torchvision-*.dist-info \
             /pkgs/torchvision.libs /pkgs/torchcodec* /pkgs/functorch /pkgs/triton /pkgs/triton-*.dist-info \
             /pkgs/nvidia /pkgs/nvidia_*.dist-info /pkgs/flash_attn /pkgs/flash_attn-*.dist-info \
             /pkgs/flash_attn_2_cuda*.so || true
      # Apply the N1.6 + headless patches.
      python3 /work/patch_leisaac.py \
        /pkgs/leisaac/policy/service_policy_clients.py \
        /pkgs/leisaac/policy/gr00t/serialization.py || true
      python3 /work/patch_headless.py /repo/scripts/evaluation/policy_inference.py || true
    '
  touch "$MARKER"
  echo ">>> [prepare] done."
else
  echo ">>> [prepare] already prepared (use --force-setup to redo)."
fi

if [ "$SETUP_ONLY" = "true" ]; then
  echo "Setup complete. Re-run without --setup-only to run the eval."
  exit 0
fi

# ─── Run the closed-loop eval against the edge policy server ─────────────────
GUI_ARGS=()
HEADLESS_FLAG="--headless"
if [ "$GUI" = "true" ]; then
  HEADLESS_FLAG=""
  GUI_ARGS=(-e "DISPLAY=${DISPLAY:-:0}" -v /tmp/.X11-unix:/tmp/.X11-unix)
  echo ">>> GUI mode: attempting a window on ${DISPLAY:-:0} (needs X/DCV; may be unstable)."
fi

echo ">>> running closed-loop eval (first run compiles shaders — can take several minutes)"
docker run --rm --runtime=nvidia --network=host \
  --entrypoint bash \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e ACCEPT_EULA=Y -e OMNI_ENV_PRIVACY_CONSENT=Y \
  -e NVIDIA_DRIVER_CAPABILITIES=all -e PYTHONUNBUFFERED=1 \
  -e LEISAAC_ASSETS_ROOT=/root/assets -e PYTHONPATH=/root/pkgs \
  "${GUI_ARGS[@]}" \
  -v "$PKGS_DIR":/root/pkgs \
  -v "$REPO_DIR":/root/leisaac \
  -v "$ASSETS_DIR":/root/assets \
  -v "$CACHE_DIR":/root/.cache \
  "$ISAAC_IMAGE" \
  -lc "export LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:\${LD_LIBRARY_PATH:-} \
    && cd /root/leisaac && /workspace/isaaclab/isaaclab.sh -p scripts/evaluation/policy_inference.py \
    --task ${TASK} --eval_rounds ${EVAL_ROUNDS} ${HEADLESS_FLAG} --enable_cameras --device cuda \
    --policy_type gr00tn1.6 --policy_host ${POLICY_HOST} --policy_port ${POLICY_PORT} \
    --policy_action_horizon 16 --policy_timeout_ms 5000 \
    --policy_language_instruction \"${INSTRUCTION}\""

echo ""
echo "Eval finished. Success/failure is reported in the rollout log above"
echo "(leisaac prints one summary line; no mp4 is saved by default)."
