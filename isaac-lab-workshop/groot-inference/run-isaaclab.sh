#!/bin/bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
CONTAINER_IMAGE="${ISAAC_LAB_IMAGE:-nvcr.io/nvidia/isaac-lab:2.3.0}"
SESSION_NAME="isaac-lab"
LEISAAC_COMMIT="ef16f985e3bb2bf6f3012d0a40c2ca5c17c31cb6"
PKGS_DIR="$HOME/isaaclab-pkgs"
MARKER="$PKGS_DIR/.leisaac-installed"
ASSETS_DIR="$HOME/leisaac-assets"
ASSETS_MARKER="$ASSETS_DIR/.assets-downloaded"
SCRIPTS_DIR="$HOME/leisaac-repo"

# ─── Step 1: Install leisaac + lerobot into persistent volume ────────────────
mkdir -p "$PKGS_DIR"
if [[ ! -f "$MARKER" ]]; then
  echo ">>> Installing leisaac + lerobot packages (first-time setup, ~3-5 min)..."
  docker run --rm --gpus all \
    --entrypoint bash \
    -e ACCEPT_EULA=Y \
    -e PYTHONPATH=/workspace/isaaclab-pkgs \
    -v "$PKGS_DIR":/workspace/isaaclab-pkgs:rw \
    "$CONTAINER_IMAGE" \
    -c "/workspace/isaaclab/_isaac_sim/python.sh -m pip install \
      --target /workspace/isaaclab-pkgs \
      lerobot \
      'leisaac[gr00t] @ git+https://github.com/LightwheelAI/leisaac.git@${LEISAAC_COMMIT}#subdirectory=source/leisaac' \
    && touch /workspace/isaaclab-pkgs/.leisaac-installed"
  sudo chown -R "$(id -u):$(id -g)" "$PKGS_DIR"
  echo ">>> leisaac installation complete."
else
  echo ">>> leisaac already installed (skipping)."
fi

# ─── Step 2: Download scene assets ───────────────────────────────────────────
if [[ ! -f "$ASSETS_MARKER" ]]; then
  echo ">>> Downloading scene assets..."
  mkdir -p "$ASSETS_DIR/scenes" "$ASSETS_DIR/robots"
  curl -fsSL -o /tmp/kitchen_with_orange.zip \
    https://github.com/LightwheelAI/leisaac/releases/download/v0.1.0/kitchen_with_orange.zip
  unzip -o /tmp/kitchen_with_orange.zip -d "$ASSETS_DIR/scenes/"
  rm -f /tmp/kitchen_with_orange.zip
  curl -fsSL -o "$ASSETS_DIR/robots/so101_follower.usd" \
    https://github.com/LightwheelAI/leisaac/releases/download/v0.1.0/so101_follower.usd
  touch "$ASSETS_MARKER"
  echo ">>> Assets downloaded."
else
  echo ">>> Assets already present (skipping)."
fi

# ─── Step 3: Clone evaluation scripts ────────────────────────────────────────
if [[ ! -d "$SCRIPTS_DIR/scripts" ]]; then
  echo ">>> Cloning leisaac evaluation scripts..."
  git clone https://github.com/LightwheelAI/leisaac.git "$SCRIPTS_DIR"
  cd "$SCRIPTS_DIR" && git checkout "$LEISAAC_COMMIT"
else
  echo ">>> Evaluation scripts already present (skipping)."
fi

# ─── Step 4: Patch policy_inference.py for headless keyboard support ─────────
POLICY_PY="$SCRIPTS_DIR/scripts/evaluation/policy_inference.py"
if [[ -f "$POLICY_PY" ]] && grep -q 'self._appwindow.get_keyboard()' "$POLICY_PY"; then
  echo ">>> Patching policy_inference.py for headless support..."
  python3 - "$POLICY_PY" << 'PATCH_EOF'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()

old_init = """\
        self._appwindow = omni.appwindow.get_default_app_window()
        self._input = carb.input.acquire_input_interface()
        self._keyboard = self._appwindow.get_keyboard()
        self._keyboard_sub = self._input.subscribe_to_keyboard_events(
            self._keyboard,
            self._on_keyboard_event,
        )"""

new_init = """\
        try:
            self._appwindow = omni.appwindow.get_default_app_window()
        except Exception:
            self._appwindow = None
        self._input = carb.input.acquire_input_interface()
        if self._appwindow is not None:
            self._keyboard = self._appwindow.get_keyboard()
        else:
            self._keyboard = None
        if self._keyboard is not None:
            self._keyboard_sub = self._input.subscribe_to_keyboard_events(
                self._keyboard,
                self._on_keyboard_event,
            )
        else:
            self._keyboard_sub = None"""

if old_init in src:
    src = src.replace(old_init, new_init)
    with open(path, "w") as f:
        f.write(src)
    print("Patched policy_inference.py for headless keyboard support")
else:
    print("Already patched or structure changed — skipping")
PATCH_EOF
fi

# ─── Step 5: Prepare IsaacSim cache directories ─────────────────────────────
mkdir -p ~/docker/isaac-sim/cache/{kit,ov,pip,glcache,computecache}
mkdir -p ~/docker/isaac-sim/{logs,data,documents}

# ─── Step 6: Launch IsaacLab container ───────────────────────────────────────
echo ">>> Launching IsaacLab container..."
xhost +local:docker 2>/dev/null || true

docker run \
  --name "$SESSION_NAME" \
  --entrypoint bash \
  -it \
  --gpus all \
  -e "ACCEPT_EULA=Y" \
  -e "PRIVACY_CONSENT=Y" \
  -e DISPLAY \
  -e LEISAAC_ASSETS_ROOT=/assets \
  -e "PYTHONPATH=/workspace/isaaclab-pkgs:${PYTHONPATH:-}" \
  -v "$ASSETS_DIR":/assets:ro \
  -v "$PKGS_DIR":/workspace/isaaclab-pkgs:rw \
  -v "$SCRIPTS_DIR/scripts":/workspace/scripts:ro \
  -v ~/docker/isaac-sim/cache/kit:/isaac-sim/kit/cache:rw \
  -v ~/docker/isaac-sim/cache/ov:/root/.cache/ov:rw \
  -v ~/docker/isaac-sim/cache/pip:/root/.cache/pip:rw \
  -v ~/docker/isaac-sim/cache/glcache:/root/.cache/nvidia/GLCache:rw \
  -v ~/docker/isaac-sim/cache/computecache:/root/.nv/ComputeCache:rw \
  -v ~/docker/isaac-sim/logs:/root/.nvidia-omniverse/logs:rw \
  -v ~/docker/isaac-sim/data:/root/.local/share/ov/data:rw \
  -v ~/docker/isaac-sim/documents:/root/Documents:rw \
  --rm \
  --network=host \
  "$CONTAINER_IMAGE"
