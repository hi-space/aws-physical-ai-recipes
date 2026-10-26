# VLA Eval Gate

Turns eval results into a promote/block decision instead of a number someone
reads off a dashboard. The eval step alone only reports the simulator's exit
status, so a checkpoint at 0% success looks like one at 100%.

```
eval_report.py                       per-trial records -> eval-report.json (+ per-part breakdown)
gate_checkpoint.py                   eval-report.json  -> PROMOTE/BLOCK, exit code, MLflow
k8s-templates/rl/eval-gate-job.yaml  runs both as a CPU-only Job on EKS
```

`gate_checkpoint.py` exits non-zero on BLOCK. The gate Job sets
`backoffLimit: 0` and the Argo submit step waits on the Job, so a BLOCK fails
the workflow and holds back every step chained behind it.

```bash
cd ../../../k8s-templates

# gate on open-loop action MSE (the default input)
MAX_MSE=400 ./render.sh rl/eval-gate-job.yaml --apply

# gate on task success rate, and promote on pass
GATE_INPUT=trials GATE_SOURCE=/fsx/scratch/eval/trials.jsonl \
THRESHOLD=0.5 PROMOTE_ALIAS=staging \
  ./render.sh rl/eval-gate-job.yaml --apply
```

`GATE_INPUT=openloop` gates on action MSE and can only block. `trials` and
`rollout` gate on task success rate and can also move a Model Registry alias
when `PROMOTE_ALIAS` is set. The `vla-eval-gate` workflow template chains
eval -> gate; see `eks/argo/workflow-templates.yaml`.

## Input sources

Real-robot trials carry per-part detail. A leisaac sim log carries only
aggregate `[N/M]`, so it is expanded into N synthetic records to keep one
aggregation path.

```bash
python ../eval_report.py --trials real_pick_2026-10-22.jsonl

python ../eval_report.py --rollout-log /fsx/scratch/logs/closed-loop-1234.out \
  --checkpoint-name groot-so101-ckpt-2000
```

Per-trial record format. `scenario: random_sequential` is excluded from the
per-part breakdown — a multi-part sequence has no single part to blame.

```json
{"checkpoint": "GR00T-SC060-40000step-preset", "part": "P001",
 "scenario": "single_center", "trial": 1, "success": false,
 "source": "human_scored", "ts": "2026-10-22T05:51:27Z"}
```

`source` records how success was determined — `human_scored` for a hand-scored
run, or the detector that produced it (`gripper_current+lift`, `tray_weight`).

## Example

`real_pick_2026-10-22.jsonl` holds 48 attempts from a real-robot run
(2 checkpoints x 7 parts x 3 trials, plus 3 random-placement sequential runs).
It ships as a fixture so the gate can be run without hardware.

```bash
python ../eval_report.py --trials real_pick_2026-10-22.jsonl
python ../gate_checkpoint.py --report eval-report.json --threshold 0.5 \
  --require-distinguishable --max-systematic-failures 1
```

```
  pi05-hdr-thor01-SC100-VRDpinch-40000step-closure
    success: 4/24 = 17%   95% CI [7%, 36%]
    random_sequential: 0/3 = 0%
    zero-success parts: P001, P002, P003, P004

  GR00T-SC060-40000step-preset
    success: 3/24 = 12%   95% CI [4%, 31%]

  SYSTEMATIC: P001, P002, P003 failed every attempt on every checkpoint.

  comparison: 17% vs 12%  (n=24 per arm)
    NOT distinguishable — needs ~1123 trials per arm for 80% power.

Gate: BLOCK
  BLOCKED: success_rate 17% below threshold 50% (4/24 trials)
  BLOCKED: margin over runner-up is within noise (n=24 per arm, needs ~1123)
  BLOCKED: 3 parts fail every attempt (limit 1): P001, P002, P003
```

## Thresholds

`--threshold` alone is a weak gate at low success rates, because an aggregate
number can clear the bar while the run is unusable.

```
--require-distinguishable      block when the margin over runner-up is noise
--max-systematic-failures N    block when more than N parts fail every attempt
```

A part that fails on every checkpoint implicates the part geometry or grasp
pose rather than the model, so it is a data-collection target and should not be
absorbed into a model score.

## MLflow

When `MLFLOW_TRACKING_URI` is set, the gate logs `eval_success_rate`,
`eval_total_trials`, and `gate_promoted` to the same tracking server
`train_groot.py` and `train_pi0.py` use. Unset, it prints a skip notice and
proceeds — the decision never depends on MLflow being reachable.

## Open gaps

Success detection on real hardware. The fixture's `source` is `human_scored`.
Until a detector (gripper current + lift height, tray weight, or an overhead
bin-diff camera) emits those records, this path automates reporting and gating
but not measurement.

No pi05 eval path. `policy_server.py` loads GR00T only, and the closed-loop
sbatch passes `--policy_type gr00t${GROOT_VERSION}`, so the policy family is
fixed even though the version is not. Training exists (`../train_pi0.py`) but
serving does not, so reproducing the fixture's comparison in sim requires an
openpi policy server.
