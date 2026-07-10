# Sequential Policy Validation

This file records validation for [workflow.yaml](workflow.yaml).

## 2026-05-02 Fresh Run

Status: Passed

Commands:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/sequential-policy/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

Observed result:

- Workflow: `aws-physical-ai-sequential-policy-2`
- Wrapper runtime: `116s` after prewarm
- G7e NodeClaim: `aws-osmo-g7e-6dr9b`
- Instance type: `g7e.2xlarge`
- Node: `ip-10-40-14-53.ap-northeast-2.compute.internal`
- GPU task ran `nvidia-smi`.
- GPU: `NVIDIA RTX PRO 6000 Blackwell Server Edition`
- Driver/CUDA: `580.126.09` / `13.0`
- Prepared dataset checksum: `50077e2cb12102a6da2a89d6575cefe4`
- Policy checkpoint checksum: `95b3fb6e2d621ba0efd6eedf674eb69d`
- Policy release checksum: `9dd3f3f6ce1410ed7caf6ee6f4e09984`
- G7e cleanup completed at `2026-05-02T13:40:54Z`.

Expected completion time:

- Observed `116s` after prewarm
- Budget `10-15 min` including G7e provisioning and cleanup

Notes:

- This is a workflow-shape example. Replace the GPU task body with a real GR00T, OpenPI, or Isaac Lab training command for a model-specific run.
- This validation run used the former `physical-ai-sequential-policy` name. The example was later renamed to `sequential-policy` without changing the workflow shape.
