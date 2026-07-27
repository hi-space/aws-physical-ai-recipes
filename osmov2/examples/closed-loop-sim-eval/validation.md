# Closed-Loop Sim Eval Validation

This file records validation for [workflow.yaml](workflow.yaml) (Isaac Lab
2.2.0 / Isaac Sim 4.5.0) and [workflow-5.1.yaml](workflow-5.1.yaml) (Isaac Lab
2.3.0 / Isaac Sim 5.1.0).

## 2026-07-27 Runtime validation (PASSED on g6e / L40S)

Status: end-to-end runtime validation SUCCEEDED. The six source-level defects
below were fixed earlier in the day; a seventh defect (deepspeed CUDA import)
only surfaced at runtime and is documented and fixed in "Runtime fix" below.
The final run completed with `success rate: 1.0` (1/1 episode).

G7e (`g7e-rtx-pro-6000`) capacity was unavailable across all regions/sizes, so
validation ran on the approved fallback `g6e-l40s` (L40S, g6e.4xlarge) via a
temporary `workflow-g6e.yaml` that is byte-identical to `workflow.yaml` except
platform / memory / dataset name. The code path exercised is identical, so the
result validates `workflow.yaml` and `workflow-5.1.yaml` too.

Evidence (workflow `aws-closed-loop-sim-eval-g6e-8`, dataset
`closed-loop-sim-eval-g6e-artifacts:3`):

- Inference server: `Server ready: {'status': 'ok', 'message': 'Server is
  running'}`
- Rollout: `Collecting 1 episodes took 36.6 seconds`
- Result: `results: (...PnPBottleToCabinetClose..., [True], {})` →
  `success rate: 1.0`
- Artifacts produced: `eval-summary.json`, `logs/rollout.log`,
  `logs/server.log`, and one rollout video (`*_s1.mp4`).

### Runtime fix (7th defect): deepspeed CUDA op-compat check

Symptom: server exited with `MissingCUDAException: CUDA_HOME does not exist,
unable to compile CUDA op(s)` (and, when `CUDA_HOME` was forced,
`FileNotFoundError: .../bin/nvcc`).

Root cause: `transformers` calls `is_deepspeed_available()`, which uses
`importlib.util.find_spec("deepspeed")` — so whenever `deepspeed` is importable
it gets imported. `deepspeed`'s `fp_quantizer` `is_compatible()`
unconditionally calls `installed_cuda_version()` when `torch.cuda.is_available()`
is True, shelling out to `$CUDA_HOME/bin/nvcc -V`. The `nvcr.io/nvidia/isaac-lab`
image ships no `nvcc` and no `/usr/local/cuda`, so this aborts. `DS_SKIP_CUDA_CHECK`
/ `DS_BUILD_OPS` do NOT bypass this code path. `deepspeed==0.17.6` is a locked
gr00t dependency, so it cannot simply be removed from the lockfile.

Fix (applied to both `workflow.yaml` and `workflow-5.1.yaml`): GR00T inference
needs none of deepspeed, so before starting the server, sync the venv, uninstall
deepspeed, then launch with `--no-sync` so uv does not reinstall it. With
deepspeed no longer importable, `find_spec` returns `None` and transformers skips
the import entirely.

```bash
uv sync
uv pip uninstall deepspeed >/dev/null 2>&1 || true
uv run --no-sync python gr00t/eval/run_gr00t_server.py ...
```

### Infra note: Karpenter consolidation killed the node mid-run

Early g6e attempts failed with "imminent node shutdown" during setup. This was
NOT AWS capacity reclamation — Karpenter's `WhenEmptyOrUnderutilized`
consolidation deleted the node (`Empty/... delete: nodepools=[aws-osmo-g6e]:
savings: $3.00`) once the prewarm/hold pod died and the node looked Empty. For
the validation run the g6e NodePool disruption budget was temporarily locked
(`kubectl patch nodepool aws-osmo-g6e ... budgets:[{nodes:"0"}]`), then restored
to the original `budgets:[{nodes:"10%"}]` afterward. Real OSMO workflow pods
carry `karpenter.sh/do-not-disrupt: "true"` so they are not consolidated while
Running; the failure only affected the manual hold pod used to pre-register
capacity. No YAML change is required for this — it is an operational note.

## 2026-07-27 Source-level audit (pre-runtime)

Status: the six blocking defects below were FIXED the same day (see "Fixes
applied" at the end); the workflow now matches the canonical upstream flow.
The seventh (deepspeed) defect above was found at runtime. The original audit is
kept below for the record.

A source-level audit against the pinned upstream ref found blocking CLI/env
defects that would abort the `rollout_policy.py` step before any GPU work.

Method: cloned `NVIDIA/Isaac-GR00T` at the pinned
`isaac_groot_ref = ead52833afbbf4243f8cd5e7664f48a94de03b19` and read the actual
`gr00t/eval/run_gr00t_server.py`, `gr00t/eval/rollout_policy.py`,
`gr00t/eval/sim/env_utils.py`, `gr00t/policy/server_client.py`, and the
canonical `examples/robocasa-gr1-tabletop-tasks/README.md`. Both workflow files
are byte-identical except image / memory / storage / dataset name, so every
defect below applies to both.

### Verified OK

- `gr00t/eval/run_gr00t_server.py` exists and its flags `--model_path`,
  `--embodiment_tag`, `--host`, `--port` all parse (tyro `ServerConfig`).
- `gr00t/eval/rollout_policy.py` exists; flags `--policy_client_host`,
  `--policy_client_port`, `--env_name`, `--n_episodes`, `--n_action_steps` all
  exist in its `argparse`.
- The ZMQ ping handshake shape is right: `PolicyServer` registers a `ping`
  endpoint and the wire format is `msgpack` (`MsgSerializer`), matching
  `entry.sh`'s readiness probe (`{'endpoint': 'ping', 'data': {}}`).

### Blocking defects (must fix before first run)

1. **`--record_dir` does not exist.** `rollout_policy.py`'s `argparse` has no
   `--record_dir`; the video directory is auto-generated internally
   (`/tmp/sim_eval_videos_*`). `argparse` rejects unknown flags, so the eval
   step exits `2` immediately. Remove `--record_dir` from the invocation. The
   workflow's `${ARTIFACT_DIR}/videos` will therefore stay empty unless the
   internal `/tmp/sim_eval_videos_*` path is copied into `artifacts/` before the
   output-dataset step (or `rollout_policy.py` is patched to accept a dir).

2. **`env_name` default is invalid.** `robocasa_gr1/PnPCounterToCab` is not a
   real env. `get_embodiment_tag_from_env_name` maps only the prefixes `gr1`,
   `gr1_unified`, `robocasa_panda_omron`, etc.; prefix `robocasa_gr1` is
   unmapped, so it falls through to `EmbodimentTag("robocasa_gr1")` and raises
   `ValueError`. Real env ids use the `gr1_unified/` prefix with the full
   suffix, e.g.
   `gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env`
   (see the canonical README's 24-task table). The three "Available
   environments" rows in this example's README are likewise fabricated and must
   be replaced with real ids.

3. **The rollout env is not installed by the workflow.** `rollout_policy.py`
   for GR1 imports `robocasa` / `robosuite` and, upstream, runs from a
   dedicated venv built by
   `gr00t/eval/sim/robocasa-gr1-tabletop-tasks/setup_RoboCasaGR1TabletopTasks.sh`
   (installs robosuite `v1.5.1`, the robocasa-gr1-tabletop submodule,
   `gymnasium==0.29.1`, etc.). `entry.sh` only does
   `uv pip install lerobot zmq msgpack-python` into `/tmp/groot-venv`, so the
   `import robocasa` inside `create_eval_env` will `ModuleNotFoundError`. The
   setup script (plus its git submodule + asset download) has to run first.

4. **`uv pip install -e ".[eval]"` targets a non-existent extra.** `pyproject.toml`
   at the pinned commit defines only a `dev` extra. The `2>/dev/null || uv pip
   install -e .` fallback masks this, but it means the "eval" dependency set is
   never actually installed — reinforcing defect 3.

5. **Server/client embodiment mismatch.** The canonical flow runs the server
   with `--embodiment-tag GR1 --use-sim-policy-wrapper` for robocasa GR1 eval.
   This workflow starts the server with `NEW_EMBODIMENT` and no sim wrapper. For
   a GR1 robocasa env the server must use `GR1` (+ sim policy wrapper); keep
   `NEW_EMBODIMENT` only for a matching custom-embodiment env.

6. **Missing `--n_envs` / `--max_episode_steps`.** The canonical rollout passes
   `--n_envs 5` and `--max_episode_steps=720`. Both have defaults (`n_envs=8`,
   `max_episode_steps=504`) so they are not fatal, but `n_envs=8` needs far more
   than 64Gi and will OOM the stable pod; set `--n_envs` explicitly to match
   pod memory.

### Recommended corrected invocation (target shape)

Server (GR1 robocasa eval):

```bash
python gr00t/eval/run_gr00t_server.py \
  --model_path /tmp/model-weights \
  --embodiment_tag GR1 \
  --use_sim_policy_wrapper \
  --host 0.0.0.0 --port "${POLICY_PORT}"
```

Client (after running `setup_RoboCasaGR1TabletopTasks.sh` and using its venv):

```bash
gr00t/eval/sim/robocasa-gr1-tabletop-tasks/robocasa_uv/.venv/bin/python \
  gr00t/eval/rollout_policy.py \
  --n_episodes "${N_EPISODES}" \
  --policy_client_host "${POLICY_HOST}" \
  --policy_client_port "${POLICY_PORT}" \
  --max_episode_steps=720 \
  --env_name gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env \
  --n_action_steps "${N_ACTION_STEPS}" \
  --n_envs 1
# no --record_dir; copy /tmp/sim_eval_videos_* into ${ARTIFACT_DIR}/videos after.
```

### Verified at runtime (g6e run, 2026-07-27)

- [x] Asset download in `setup_RoboCasaGR1TabletopTasks.sh` completes inside the
      pod (git submodule + sim assets) within the g6e pod's 200Gi storage.
- [x] Video collection path with `--record_dir` dropped — one `*_s1.mp4` was
      collected from `/tmp/sim_eval_videos_*` into `${ARTIFACT_DIR}/videos`.
- [x] Memory: `--n_envs 1` runs comfortably (g6e pod 90Gi; no OOM).
- [x] `LEISAAC_*` removal confirmed harmless (already dropped in the 6-defect
      fixes; the run does not touch leisaac).

### Fixes applied (2026-07-27)

Re-audited against the same pinned ref after editing both workflow files:

- [x] **1. `--record_dir` removed.** No longer passed to `rollout_policy.py`;
      videos are collected from the script's internal `/tmp/sim_eval_videos_*`
      dir into `${ARTIFACT_DIR}/videos` after the run.
- [x] **2. `env_name` fixed** to
      `gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env`
      (canonical README default). README "Available environments" replaced with
      real `gr1_unified/…` ids.
- [x] **3. rollout env installed.** `entry.sh` now runs
      `setup_RoboCasaGR1TabletopTasks.sh` (git submodule + robosuite v1.5.1 +
      robocasa + asset download) and runs `rollout_policy.py` from the
      resulting `robocasa_uv/.venv` python. The ZMQ ping probe also runs from
      that venv (setup installs `zmq`+`msgpack` there).
- [x] **4. `.[eval]` extra dropped.** Server now runs via `uv run python …`
      against the gr00t project (tyro/deps resolved by uv); the model-download
      helper uses `uv run --no-project --with huggingface_hub`.
- [x] **5. Server embodiment fixed.** `--embodiment_tag GR1
      --use_sim_policy_wrapper` (both verified as real `ServerConfig` fields);
      default `embodiment_tag` changed `NEW_EMBODIMENT` → `GR1`.
- [x] **6. `LEISAAC_*` removed** from both files (unused; belonged to the
      04-closeloop leisaac path). Added explicit `--n_envs` (default 1, to fit
      pod memory) and `--max_episode_steps=720` to match the canonical rollout.

Also added `libegl1-mesa-dev`/`libglu1-mesa` + `MUJOCO_GL=egl` (robosuite EGL
headless render deps, per the workshop setup README).

Re-verification: all flags (`--use_sim_policy_wrapper`, `--n_envs`,
`--max_episode_steps`) confirmed present in the pinned `run_gr00t_server.py` /
`rollout_policy.py`; `EmbodimentTag.GR1` exists; the `robocasa_uv/.venv` path
matches what `setup_RoboCasaGR1TabletopTasks.sh` builds. Both YAMLs parse
(after Jinja placeholder substitution). Runtime GPU validation completed on
g6e/L40S — see "Runtime validation (PASSED on g6e / L40S)" at the top.

### Relationship to e2e-pipeline-examples/04-closeloop

`e2e-pipeline-examples/04-closeloop` is the leisaac + SO-101 closed-loop eval
and had its own CLI audit (see that directory's README "Fixed" section). This
example is the GR00T-repo robocasa/GR1 closed-loop path and is a different code
route; the two should not be conflated. The unused `LEISAAC_*` vars here are a
leftover from that conflation.
