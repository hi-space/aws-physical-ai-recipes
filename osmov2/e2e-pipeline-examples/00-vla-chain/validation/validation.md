# GPU runtime validation — 00-vla-chain

End-to-end validation of the combined `prepare → gr00t-finetune → eval` workflow
on the `us-east-1` cluster.

## What was validated

Two runs were needed. The first exposed a real defect in the chained
`eval` task; the second confirmed the fix.

| Run | `train_max_steps` | Result |
| --- | --- | --- |
| `aws-e2e-vla-chain-1` (2026-08-11 06:30 UTC) | 10000 | `eval` FAILED — checkpoint path resolution |
| `aws-e2e-vla-chain-2` (2026-08-11 09:44 UTC) | 10 (smoke) | **COMPLETED** — all three tasks |

### The defect (found by run 1)

`gr00t-finetune` copies its whole training output directory, so
`{{input:0}}/artifacts` holds *both* a `checkpoint-N/` subdirectory *and* a
partial copy of it at the root: `config.json` and the safetensors are at the
root, but `processor_config.json` is not — it sits under `processor/`. The
original `eval` task probed for `config.json` to decide "this is a loadable
model dir", so it stopped at the root and
`AutoProcessor.from_pretrained` failed with `Unrecognized processing class`.

The fix probes for `processor_config.json` instead (and asserts both files
exist), which is the file that actually distinguishes a complete HF model
directory here. This is chain-specific: the standalone Stage 4 reads a
checkpoint from a dataset input, where the root partial copy does not exist.

### Run 2 — chaining confirmed

`validation/eval-summary.json` shows the path resolving to the subdirectory,
not the root:

```json
"model_path": "/osmo/data/input/0/artifacts/checkpoint-10"
```

Task transitions, polled every ~2 min while the workflow ran, show OSMO
advancing the DAG without intervention:

| Task | Start | Duration |
| --- | --- | --- |
| `prepare` | 09:44 UTC | ~4 min |
| `gr00t-finetune` | 09:52 UTC | ~19 min (mostly startup: image pull, Isaac-GR00T clone, N1.6 3B download) |
| `eval` | 10:12 UTC | ~36 min (~13 min setup + 5 episodes) |

Total wall clock 09:44 → 10:47 UTC (~63 min) at `train_max_steps: 10`.

Run 2 deliberately kept the 10-step smoke default: the checkpoint directory
layout — the thing the fix depends on — is identical regardless of step count,
and run 1 had already measured the 10000-step training path (2.54 samples/s, see
the throughput table below).

## Node and prewarm

Platform `g6e-l40s` on a `g6e.16xlarge` in `us-east-1d`. `g6e.8xlarge`, the size
the stage READMEs recommend, was unavailable (`InsufficientInstanceCapacity`), so
the node came from the flexible GPU probe in
[docs/gpu-capacity.md](../../../docs/gpu-capacity.md#when-the-size-you-asked-for-is-sold-out-ice)
which lets Karpenter pick the size.

Delete that probe pod immediately after submitting. It holds the node's only GPU,
which left `gr00t-finetune` in `SCHEDULING` until the pod was removed.

## Success rate is 0.0 — what was ruled out

Both runs scored `success_rate: 0.0` (5/5 episodes timed out). Run 2 is a
10-step model, so 0% is trivially expected. Run 1 trained 10000 steps and also
scored 0%, and that was investigated separately:

- The logs cannot show joint maxout — neither the rollout log nor the inference
  server log records joint or action values. Only Isaac Sim manager tables,
  per-episode `timed out!` lines, and the final rate. Both were read during this
  investigation but are not kept here; the repo does not track `.log` files.
- Action representation is **not** mismatched. `state_action_processor.py` in
  the pinned eval ref is symmetric: training subtracts state to make actions
  relative, inference adds state back. `use_relative_action` round-trips through
  `processor_config.json` (`validation/chain-1-10000steps-processor_config.json`,
  taken from the run-1 checkpoint, records `use_relative_action: True` plus
  `action_configs: [RELATIVE(single_arm), ABSOLUTE(gripper)]`), and
  `Gr00tPolicy` loads it via `AutoProcessor.from_pretrained(model_dir)`.
  `dataset_statistics.json` carries separate `state` / `action` /
  `relative_action` statistics, so normalization is on the matching scale.
- The demonstrations **do** cover the success condition. `task_done` in the
  pinned eval ref requires all three oranges within ±0.10 m x/y and ±0.07 m z of
  the plate *and* the arm back inside `SO101_FOLLOWER_REST_POSE_RANGE` (six
  joints, ±30° each), while the dataset's single task annotation is singular
  ("Grab orange and place into plate") — so the demos plausibly showed only one
  orange. They do not. Reading the `action` channel of 18 episodes (0-2, 10-14,
  30-34, 50-54) directly: 14 show exactly three place-carries and 4 show four
  (retries), and 14 of 18 end inside the rest-pose window. The target is
  learnable from this data.

  Counting method, because the obvious one is wrong: the gripper (action index 5)
  reads ~2 when closed-idle at the start and end of an episode, ~19-31 while
  holding an orange, and ~40-49 when open. An open-vs-closed threshold therefore
  finds a single "cycle" per episode. Count instead the runs where the gripper
  sits in the hold band (12-34) for ≥0.5 s *and* `shoulder_pan` advances >10°
  toward the plate during that run.

That leaves the size of the training run as the leading explanation, though the
loss curve is weaker evidence for it than first assumed. The run-1
`trainer_state.json` records `epoch: 1.0` and loss falling from a 1.06 mean over
the first 20 logged steps to 0.418 over the last 20, with the cosine schedule
fully consumed — a healthy single-epoch fit, not an early plateau.
`global_batch_size: 1` × 10000 steps is exactly one pass over the ~10k samples of
the 60-episode dataset, and every episode ends in a ~4m20s timeout rather than a
crash. One epoch being too little is plausible, but it is inference from
elimination — no larger run has confirmed it.

One other candidate is untested: `eval_instruction` defaults to "pick up the
orange and place it on the plate" while every episode in the dataset is annotated
"Grab orange and place into plate", and the policy has seen no other wording.
Aligning them is free to try via `--set`.

The `e2e-workshop` repo is not a counter-example to compare against: it records
no `success_rate` anywhere, and its `groot/config.yaml` trains
`global_batch_size: 32` × `max_steps: 100` — 3200 samples, *less* than run 1.

### Throughput, for sizing a larger run

Measured on one L40S from the HF Trainer's own `train_runtime`
(`dataloader_num_workers: 4`, same dataset):

| `global_batch_size` | sec/step | samples/s | 10000 samples (~1 epoch) |
| --- | --- | --- | --- |
| 1 | 0.39 | 2.54 | ~66 min |
| 8 | 3.90 | 2.05 | ~81 min |
| 32 | 6.66 | 4.81 | ~35 min |

Batch 32 fits in 48 GB (run-1 peak was 36.0 GiB of 45.0 at batch 1, and only the
projector and diffusion head are trainable), so a larger run needs no bigger
card. Batch 8 is *worse* per sample than batch 1, so the trend is not monotonic —
measure rather than interpolate.

Read this against the ~48 min of fixed cost in a full chain (prep, two task
startups, a 5-episode eval): a 2h chain leaves ~70 min of training loop, or about
2 epochs. Raising the training volume much beyond that means giving up the 2h
budget.

## Files

- `eval-summary.json` — run 2 eval result, showing the resolved `model_path`
- `chain-1-10000steps-processor_config.json` — run 1 checkpoint processor config,
  evidence for the action-representation finding above

Raw eval logs and the polled task-transition output are not kept here — the repo
does not track `.log` files. The timings and findings above were read from them at
the time of the run.
