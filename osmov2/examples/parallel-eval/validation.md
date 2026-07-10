# Parallel Eval Validation

This file records validation for [workflow.yaml](workflow.yaml).

## 2026-05-02 Fresh Run

Status: Passed

Command:

```bash
WORKFLOW_FILE=examples/parallel-eval/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=120 \
  scripts/smoke-test.sh
```

Observed result:

- Workflow: `aws-physical-ai-parallel-eval-3`
- Wrapper runtime: `67s`
- Output dataset: `aws-osmo/aws-physical-ai-parallel-eval-summary:2`
- Output size: `88B`
- Output checksum: `a27730bbab167759743b5e44bd4f74b3`
- Aggregate metrics: `episodes=128`, `success_rate=0.905`, `mean_reward=147.775`, `shards=4`

Expected completion time:

- Observed `67s`
- Budget `2-3 min` on a warm platform

Notes:

- This is a workflow-shape example. It uses synthetic metrics so it can validate OSMO fan-out/fan-in behavior without external data.
- This validation run used the former `physical-ai-parallel-eval` name. The example was later renamed to `parallel-eval` without changing the workflow shape.
