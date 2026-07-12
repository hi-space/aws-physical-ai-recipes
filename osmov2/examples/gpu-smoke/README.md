# GPU Smoke

OSMO-submitted GPU smoke workflow. It requests the AWS G7e OSMO platform and runs `nvidia-smi`.

OSMO validates workflow resources against currently visible backend capacity, so prewarm a G7e node first:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

## G6 / G6e capacity-fallback variants

When g7e (RTX PRO 6000) capacity is unavailable in-region, submit the same smoke
against the G6 (NVIDIA L4, 24GB) or G6e (NVIDIA L40S, 48GB) fallback platforms.
The fallback NodePool and OSMO platform are opt-in, so enable them at deploy time
first (see [deploy-karpenter.sh](../../scripts/deploy-karpenter.sh) and
[deploy-osmo.sh](../../scripts/deploy-osmo.sh)):

```bash
# One-time: create the g6 NodePool + OSMO g6-l4 platform
DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh
```

```bash
GPU_PREWARM_INSTANCE_TYPE=g6.4xlarge \
  KARPENTER_NODEPOOL_NAME=aws-osmo-g6 \
  scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow-g6.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
KARPENTER_NODEPOOL_NAME=aws-osmo-g6 scripts/wait-gpu-node-cleanup.sh
```

For G6e (larger 48GB VRAM), enable the g6e NodePool + platform and use the g6e
workflow:

```bash
# One-time: create the g6e NodePool + OSMO g6e-l40s platform
DEPLOY_G6E_NODEPOOL=true scripts/deploy-karpenter.sh
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-osmo.sh
```

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.4xlarge \
  KARPENTER_NODEPOOL_NAME=aws-osmo-g6e \
  scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow-g6e.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
KARPENTER_NODEPOOL_NAME=aws-osmo-g6e scripts/wait-gpu-node-cleanup.sh
```

The g6/g6e NodePools pin to a single AZ (the deploy region's first AZ by
default); override with `KARPENTER_G6_ZONE` / `KARPENTER_G6E_ZONE` if that AZ
lacks capacity.

Validation:

- [validation.md](validation.md)
