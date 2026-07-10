# Parallel Eval

Small OSMO `groups` example that fans out four CPU evaluation shards and aggregates their metrics.

Run it through the repo wrapper:

```bash
WORKFLOW_FILE=examples/parallel-eval/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=120 \
  scripts/smoke-test.sh
```

Validation:

- [validation.md](validation.md)
- Fresh run: `aws-physical-ai-parallel-eval-3`
- Observed runtime: `67s`
- Expected completion time: `2-3 min` on a warm platform
- Output dataset: `aws-osmo/aws-physical-ai-parallel-eval-summary:2`

This is a workflow-shape example. It uses synthetic metrics so it can validate OSMO fan-out/fan-in behavior without external data.
