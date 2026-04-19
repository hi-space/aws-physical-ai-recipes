# Workshop README Verification Notes

Verified: 2026-04-20 (iteration 2)
Branch: feat/workshop-groot-so101

## Issues Found and Fixed

### Iteration 1

#### 1. setup.sh step numbering inconsistency
- **Problem**: Steps 1-4 showed `[N/7]` but steps 5-8 showed `[N/8]`. The script has 8 steps.
- **Fix**: Changed steps 1-4 from `/7` to `/8` in setup.sh.

#### 2. README setup description outdated (Module 0-4)
- **Problem**: README listed only 5 setup steps, but the actual script performs 8 steps (missing: IsaacLab RL install, mujoco_warp patch, URDF→USD conversion).
- **Fix**: Updated README to list all 8 setup steps matching the actual script.

#### 3. README project tree missing scripts
- **Problem**: `convert_urdf_to_usd.py` and `patch_mujoco_warp.py` were missing from the project structure tree in README.
- **Fix**: Added both scripts to the tree.

#### 4. play_rl.py: missing RslRlVecEnvWrapper
- **Problem**: `play_rl.py` passed the raw Gymnasium env to `OnPolicyRunner`, which requires `RslRlVecEnvWrapper`. Error: `AttributeError: 'OrderEnforcing' object has no attribute 'get_observations'`.
- **Fix**: Added `RslRlVecEnvWrapper(env)` wrapping, matching `train_rl.py`.

#### 5. play_rl.py: wrong step() unpack (5 values → 4)
- **Problem**: `obs, _, _, _, _ = env.step(actions)` — `RslRlVecEnvWrapper.step()` returns 4 values `(obs, rew, dones, extras)`, not 5.
- **Fix**: Changed to `obs, _, _, _ = env.step(actions)`.

#### 6. collect_demos.py: same missing wrapper and step unpack issues
- **Problem**: Same as #4 and #5 — missing `RslRlVecEnvWrapper` and 5-value unpack.
- **Fix**: Added wrapper and fixed unpack to 4 values. Also added TensorDict-aware obs extraction (`obs["policy"]`).

#### 7. Checkpoint path format mismatch
- **Problem**: README and `play_rl.py` auto-detection pattern referenced `logs/rsl_rl/<name>/<timestamp>/checkpoints/best_agent.pt`, but rsl_rl saves as `logs/rsl_rl/<name>/model_<iter>.pt`.
- **Fix**: Updated `play_rl.py` glob pattern to `model_*.pt` with numeric sorting. Updated README examples to show correct path format.

#### 8. mujoco_warp patch: version pinning note
- **Problem**: If `mujoco_warp` gets upgraded from `0.0.1` to `3.7.0.1`, the patch patterns don't match and the new version is incompatible with the current warp install.
- **Note**: The `setup.sh` doesn't pin `mujoco_warp` version. As long as `isaaclab_newton` pins it correctly via its dependency, this is OK. If it breaks, `pip install "mujoco_warp==0.0.1"` and re-run `patch_mujoco`.

### Iteration 2

#### 9. rsl_rl 3.0.1 incompatible with isaaclab_rl algorithm config
- **Problem**: `RslRlPpoAlgorithmCfg` from `isaaclab_rl` (feature/newton branch) includes fields `optimizer` and `share_cnn_encoders` that `rsl_rl==3.0.1` PPO.__init__() doesn't accept. Error: `TypeError: PPO.__init__() got an unexpected keyword argument 'optimizer'` (then `'share_cnn_encoders'` after first fix).
- **Root cause**: The official IsaacLab training script calls `handle_deprecated_rsl_rl_cfg()` which strips `optimizer` for rsl_rl < 4.0, but `share_cnn_encoders` (added for rsl_rl 5.0) isn't handled by that utility.
- **Fix**: Added `handle_deprecated_rsl_rl_cfg()` call + `_strip_unknown_alg_keys()` helper that introspects `PPO.__init__` signature and strips any unrecognized keys. Applied to all three scripts: `train_rl.py`, `play_rl.py`, `collect_demos.py`.

#### 10. collect_demos.py: TensorDict obs indexing failure
- **Problem**: `obs` from `RslRlVecEnvWrapper` is a `TensorDict`, not a plain `dict`. `isinstance(obs, dict)` returns `False`, so the code tried `obs[0, :6]` directly on the TensorDict, causing `IndexError: tuple index out of range`.
- **Fix**: Changed the isinstance check to `hasattr(obs, "__getitem__") and "policy" in obs` which works for both dict and TensorDict.

## Verified Working (Module 0)

- [x] `list_envs` — shows 4 registered environments
- [x] `train_rl --task Workshop-SO101-Reach-v0 --headless --num_envs 16 --max_iterations 3` — completes, creates model_0.pt, model_2.pt
- [x] `train_rl --task Workshop-SO101-Lift-v0 --headless --num_envs 16 --max_iterations 3` — completes, creates model_0.pt, model_2.pt
- [x] `play_rl --task Workshop-SO101-Reach-Play-v0 --headless --num_steps 50` — runs with latest checkpoint
- [x] `play_rl --task Workshop-SO101-Lift-Play-v0 --headless --num_steps 50` — runs with latest checkpoint
- [x] `collect --task Workshop-SO101-Lift-Play-v0 --checkpoint model_1499.pt --num_episodes 2 --output_dir /tmp/test --headless` — collects 2 episodes (750 steps each, 6-DOF states/actions)
- [x] `convert --input_dir ... --output_dir ...` — produces valid LeRobot v2.1 dataset (info.json, parquet, modality.json)
- [x] `download_hf --help` — parses correctly, modality.json path resolves
- [x] `upload_s3 --help` — parses correctly
- [x] `submit_batch --help` — parses correctly
- [x] `closed_loop --help` — parses correctly
- [x] `convert_urdf --help` — parses correctly
- [x] `patch_mujoco` — patches and is idempotent
- [x] All 12 script modules import successfully with `main()` entry point

## Not Verifiable Locally

- `download_hf` actual execution (needs Isaac-GR00T `convert_v3_to_v2.py`)
- `upload_s3` actual execution (needs AWS credentials + bucket)
- `submit_batch` actual execution (needs AWS Batch setup)
- `closed_loop` actual execution (needs running GR00T Policy Server)
- GR00T finetuning (needs Isaac-GR00T + large GPU memory)

## Files Modified (Iteration 2)

- `src/workshop/scripts/train_rl.py` — added `handle_deprecated_rsl_rl_cfg()` + `_strip_unknown_alg_keys()` for rsl_rl 3.0.1 compatibility
- `src/workshop/scripts/play_rl.py` — same rsl_rl compatibility fix
- `src/workshop/scripts/collect_demos.py` — same rsl_rl compatibility fix + TensorDict obs extraction fix
- `VERIFICATION_NOTES.md` — updated with iteration 2 findings

## Files Modified (Iteration 1)

- `setup.sh` — fixed step numbering [1/7]→[1/8] through [4/7]→[4/8]
- `README.md` — updated setup steps list, project tree, checkpoint path examples
- `src/workshop/scripts/play_rl.py` — added RslRlVecEnvWrapper, fixed step unpack, fixed checkpoint glob pattern
- `src/workshop/scripts/collect_demos.py` — added RslRlVecEnvWrapper, fixed step unpack, TensorDict-aware obs extraction
