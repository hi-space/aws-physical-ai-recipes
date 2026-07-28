# GR00T Fine-Tune

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

NVIDIA `GR00T-N1.6-3B`, 업스트림 SO100 `cube_to_bowl_5` 데이터 경로, 그리고 `versions.yaml`에 고정된 소스 ref를 사용하는 PASK 정렬 GR00T fine-tune 워크플로우.

파일:

| 파일 | 스택 | 비고 |
| --- | --- | --- |
| [workflow.yaml](workflow.yaml) | PyTorch 25.03 (Isaac Sim 4.5 시대) | stable, 검증 완료 |
| [workflow-g6.yaml](workflow-g6.yaml) | PyTorch 25.03, G6 L4 플랫폼 | G6 fallback |
| [workflow-5.1.yaml](workflow-5.1.yaml) | PyTorch 25.04 (Isaac Sim 5.1 시대) | latest |

- [validation.md](validation.md): 검증 결과, 플롯, replay, 실행 매니페스트.
- [validation/](validation/): 보존된 검증 아티팩트.

제한된 E2E 검증 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  SMOKE_SET_HF_CREDENTIAL=true \
  HF_TOKEN_FILE="$HOME/.huggingface/token" \
  WORKFLOW_FILE=examples/gr00t-finetune/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

워크플로우가 `cpu: 16`, `memory: 96Gi`, `gpu: 1`을 요청하므로 검증된 경로에는 `g7e.8xlarge`를 사용하십시오.

SO-101 튜토리얼 checkpoint 규모에 맞는 품질 지향의 장기 실행:

```bash
osmo workflow submit examples/gr00t-finetune/workflow.yaml \
  --pool default \
  -t json \
  --set max_steps=10000 \
  --set save_steps=10000 \
  --set save_total_limit=1 \
  --set global_batch_size=1 \
  --set gpu_metrics_interval_seconds=10 \
  --set-string output_dataset=gr00t-finetune-10k-artifacts \
  --set-string retain_model_weights=true
```

기본 워크플로우 값은 이 저장소가 OSMO 실행, 자격증명, 스케줄링, 아티팩트 업로드, 정리를 검증하는 데 사용하기 때문에 의도적으로 작게 설정되어 있습니다. 완전한 policy 품질 벤치마크가 아닙니다.
