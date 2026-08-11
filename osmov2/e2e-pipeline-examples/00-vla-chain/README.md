# Stage 0 — VLA Chain (one submit: 01 → 03 → 04)

Single-submit variant of the SO-101 GR00T VLA chain. Data prep → GR00T fine-tune
→ LeIsaac closed-loop eval run as three tasks in **one** workflow, chained with
OSMO task dependencies, so you submit once and OSMO advances the DAG on its own.

This is the VLA chain, not every stage in this directory. Stage 2 (H1 humanoid
RL) is a separate track that neither feeds nor consumes these datasets, Stage 5
(edge) is a Greengrass deployment rather than an OSMO workflow, and Stage 6
(Cosmos augmentation) is optional and left out to keep the timeout manageable.
Stage 4 is itself the simulation step — Isaac Sim + LeIsaac rollout — so the
chain does cover sim, just not the RL track.

```
prepare (CPU) ──▶ gr00t-finetune (GPU) ──▶ eval (GPU)
01-data-prep         03-vla-finetune      04-closeloop
```

- OSMO input: none (pulls the dataset from Hugging Face)
- OSMO outputs: `e2e-vla-chain-lerobot-dataset`,
  `e2e-vla-chain-groot-checkpoint`, `e2e-vla-chain-closeloop-artifacts`

The output dataset names are deliberately distinct from the per-stage
`e2e-pipeline-*` names so a chain run never overwrites artifacts from the
individually-run stages.

## This vs. the per-stage workflows

[`01-data-prep`](../01-data-prep/README.md),
[`03-vla-finetune`](../03-vla-finetune/README.md) and
[`04-closeloop`](../04-closeloop/README.md) remain the authoritative,
independently runnable versions. This file copies their task bodies.

| | Per-stage (01/03/04) | This file |
| --- | --- | --- |
| Submits | 3, each waiting on the previous | 1 |
| Chaining | by dataset name (`--set input_dataset=…`) | `inputs: - task: <name>` |
| Restart granularity | re-run only the failed stage | whole workflow (see below) |
| Best for | development, debugging, partial re-runs | unattended end-to-end runs |

Pick a stage directory when you are iterating on one step. Pick this file when
you want the whole chain to run without a human in between.

The restart difference is the real cost of bundling. `osmo workflow restart`
takes a workflow id with no task selector, so a failure in `eval` cannot be
retried on its own the way re-submitting `04-closeloop` can — and whether a
restart re-runs the already-completed `gr00t-finetune` task is unverified.
Assume it might. With a real `train_max_steps`, that is hours of GPU time at
risk, so prefer the per-stage path while a config is still unproven, and switch
to this file once a full run is known to work.

## Prefixed variables

`default-values` is one flat namespace, so every variable is prefixed by stage:
`prep_*`, `train_*`, `eval_*`. This is what lets the two different pinned
Isaac-GR00T refs coexist in a single workflow — `train_gr00t_ref`
(`ead52833…`, the fine-tune pin) and `eval_gr00t_ref` (`e8e625f4…`, leisaac's
N1.6 ZMQ server-compat pin). Every other knob from the three source stages is
carried over unchanged, just renamed.

## Timeout

`exec_timeout` is workflow-scoped, not per-task, so it must cover the whole
chain: 2h (prep) + 12h (train) + 4h (eval) plus node-provisioning headroom →
`20h`. Raise it if you increase `train_max_steps` substantially.

## Running

Both GPU tasks default to `g6e-l40s`. The training task is the larger request
(`cpu: 16` / `memory: 96Gi`), so prewarm `g6e.8xlarge`; the eval task fits on
the same NodePool.

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/00-vla-chain/workflow.yaml \
  --set prep_hf_dataset_id=LightwheelAI/leisaac-pick-orange \
        train_max_steps=10000 train_save_steps=10000

scripts/wait-gpu-node-cleanup.sh
```

Pass every override in a **single** `--set` with space-separated `k=v` pairs.
Repeating the `--set` flag makes the OSMO CLI (6.3.x) keep only the last
occurrence and silently drop the rest, which matters more here than in the
per-stage workflows because a full run overrides variables from three stages at
once. Verify what actually rendered with
`osmo workflow submit … --dry-run 2>&1 | grep -E 'platform|max_steps'`.

To move both GPU tasks to the 96GB g7e (RTX PRO 6000) card — the g7e NodePool is
always deployed, so no redeploy is needed:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/00-vla-chain/workflow.yaml \
  --set train_platform=g7e-rtx-pro-6000 eval_platform=g7e-rtx-pro-6000
```

`train_max_steps` defaults to `10` (a smoke value inherited from Stage 3). An
unattended run whose eval result is meaningful needs a real budget — `10000`
steps at `train_global_batch_size: 1` is roughly 8h on one L40S, which fits the
20h `exec_timeout` alongside prep and eval.

## Task chaining details

Each task's output directory is mounted as the next task's `{{input:0}}`, so the
paths differ slightly from the dataset-input versions:

| Task | Reads | Writes |
| --- | --- | --- |
| `prepare` | Hugging Face | `{{output}}/artifacts/dataset` |
| `gr00t-finetune` | `{{input:0}}/artifacts/dataset` | `{{output}}/artifacts/checkpoint-N` |
| `eval` | `{{input:0}}/artifacts` (highest `checkpoint-*`) | `{{output}}/artifacts/{eval-summary.json,logs/}` |

Both consumer tasks keep the source stages' fallback search (locate
`meta/info.json` / `config.json` under the input root), so they still work if
OSMO nests the mounted output differently.

## Requirements

Same as the stages it composes:

- An `huggingface_token` OSMO credential (`HF_TOKEN`) for the dataset download
  and the `nvidia/GR00T-N1.6-3B` base model.
- A GPU NodePool with visible capacity before submit — enable g6e at deploy with
  `DEPLOY_G6E_NODEPOOL=true OSMO_CONFIGURE_G6E_PLATFORM=true`. See
  [docs/gpu-capacity.md](../../docs/gpu-capacity.md).

## Status

Structurally derived from the three runtime-relevant stages with their task
bodies copied verbatim (only the variable names, the `inputs:` chaining and the
two input paths differ). The chaining mechanism itself — `inputs: - task: <name>`
within one workflow — is the same one used by
[`examples/sequential-policy`](../../examples/sequential-policy/README.md).

End-to-end runtime validation of this combined workflow on GPU is **pending**;
artifacts should land under `00-vla-chain/validation/` once it runs for real.
Run the per-stage workflows first if you need a verified path.
