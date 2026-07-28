# GPU Smoke

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

OSMO로 제출하는 GPU 스모크 워크플로우입니다. AWS G7e OSMO 플랫폼을 요청하고
`nvidia-smi`를 실행합니다.

OSMO는 현재 관측 가능한 백엔드 용량에 대해 워크플로우 리소스를 검증하므로,
먼저 G7e 노드를 프리웜하세요:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

## G6 / G6e 용량 폴백 변형

해당 리전에서 g7e (RTX PRO 6000) 용량이 없을 경우, 동일한 스모크를
G6 (NVIDIA L4, 24GB) 또는 G6e (NVIDIA L40S, 48GB) 폴백 플랫폼에 대해 제출하세요.
폴백 NodePool과 OSMO 플랫폼은 선택 사항이므로, 먼저 배포 시 활성화해야 합니다
([deploy-karpenter.sh](../../scripts/deploy-karpenter.sh) 및
[deploy-osmo.sh](../../scripts/deploy-osmo.sh) 참고):

```bash
# 최초 1회: g6 NodePool + OSMO g6-l4 플랫폼 생성
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

G6e (더 큰 48GB VRAM)의 경우, g6e NodePool + 플랫폼을 활성화하고 g6e 워크플로우를
사용하세요:

```bash
# 최초 1회: g6e NodePool + OSMO g6e-l40s 플랫폼 생성
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

g6/g6e NodePool은 기본적으로 단일 AZ(배포 리전의 첫 번째 AZ)에 고정됩니다.
해당 AZ에 용량이 없는 경우 `KARPENTER_G6_ZONE` / `KARPENTER_G6E_ZONE`으로
오버라이드하세요.

검증:

- [validation.md](validation.md)
