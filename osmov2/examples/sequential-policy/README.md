# Sequential Policy

Small CPU/GPU/CPU workflow that models a typical policy pipeline shape: inspect dataset, run a GPU policy checkpoint task, then package release artifacts.

Run it through the repo wrapper:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/sequential-policy/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

Validation:

- [validation.md](validation.md)
- Fresh run: `aws-physical-ai-sequential-policy-2`
- Observed runtime: `116s` after G7e prewarm
- Expected completion time: `10-15 min` including G7e provisioning and cleanup
- GPU: RTX PRO 6000 Blackwell, driver `580.126.09`, CUDA `13.0`

This is a workflow-shape example. Replace the GPU task body with a real GR00T, OpenPI, or Isaac Lab training command for a model-specific run.
