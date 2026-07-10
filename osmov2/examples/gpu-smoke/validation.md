# GPU Smoke Validation

This file records validation for [workflow.yaml](workflow.yaml).

## 2026-04-29 Karpenter G7e GPU Smoke

Status: Passed

Commands:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
OSMO_VALIDATE_KARPENTER=true \
  OSMO_VALIDATE_GPU_OPERATOR=true \
  OSMO_VALIDATE_GPU_NODE=true \
  OSMO_VALIDATE_KAI_BIND_LOG=true \
  scripts/validate-platform.sh
```

Observed result:

- Workflow: `aws-osmo-gpu-smoke-2`
- G7e prewarm created the first GPU node from zero G7e nodes.
- Node type: `g7e.2xlarge`
- GPU: `NVIDIA RTX PRO 6000 Blackwell Server Edition`
- Driver/CUDA: `580.126.09` / `13.0`
- The GPU node exposed `nvidia.com/gpu: 1`.
- Workflow log included `NVIDIA RTX PRO 6000 Blackwell Server Edition, 97887 MiB`.
- KAI binder log showed the OSMO GPU workflow pod bound to the G7e node.
- Backend pods did not enter `CrashLoopBackOff`.

Notes:

- OSMO validates workflow resources against currently visible backend capacity.
  This workflow therefore uses G7e prewarm before submission.
