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

## 2026-07-11 OSMO 6.3.1 GPU Smoke (G6/L4 capacity fallback)

Status: Passed

Re-validated the GPU path on OSMO 6.3.1 (chart 1.3.1). G7e (RTX PRO 6000) was
out of capacity in `ap-northeast-2a` and `ap-northeast-2b`
(`InsufficientInstanceCapacity`), so this run used the G6 (NVIDIA L4) capacity
fallback: the `aws-osmo-g6` Karpenter NodePool plus the OSMO `g6-l4` platform
(`OSMO_CONFIGURE_G6_PLATFORM=true`). The workflow is `examples/gpu-smoke/workflow.yaml`
with `platform: g6-l4`.

Commands:

```bash
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh
GPU_PREWARM_INSTANCE_TYPE=g6.2xlarge KARPENTER_NODEPOOL_NAME=aws-osmo-g6 \
  scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=<gpu-smoke workflow with platform: g6-l4> \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

Observed result:

- Workflow: `aws-osmo-gpu-smoke-2`
- G6 prewarm created a `g6.2xlarge` node from zero G6 nodes.
- GPU: `NVIDIA L4`, 23034 MiB; Driver/CUDA `580.126.09` / `13.0`.
- Workflow task pod ran **2/2** with the OSMO-injected `init` + `client`
  containers — confirms the 6.3-required `workflow.backend_images` (init/client)
  are configured; without them the backend operator produces a task pod with
  empty container images and Kubernetes rejects it (422).
- `nvidia-smi` succeeded; `cuda_burn` ran 120 s / 13620 launches at 100% GPU util.
- Workflow completed in 254 s.
- `scripts/wait-gpu-node-cleanup.sh` confirmed Karpenter removed the empty GPU node.

Notes:

- Because 6.3 makes `workflow.backend_images` mandatory, a GPU (workflow-task)
  run is the meaningful regression gate for the upgrade — a CPU smoke alone does
  not exercise the injected init/client containers.
- Prefer G7e (`platform: g7e-rtx-pro-6000`) when capacity is available; use the
  G6/L4 fallback only when G7e is unfulfillable in-region.
