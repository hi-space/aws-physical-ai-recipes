# OpenPI LIBERO LoRA

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

업스트림 `pi0_libero_low_mem_finetune` config와 HF `physical-intelligence/libero` 데이터셋 에피소드 서브셋을 사용하는 PASK 정렬 OpenPI LoRA 워크플로우.

파일:

- [workflow.yaml](workflow.yaml): OSMO 워크플로우 정의.
- [validation.md](validation.md): 검증 결과, 플롯, replay, 실행 매니페스트.
- [validation/](validation/): 보존된 검증 아티팩트.

제한된 E2E 검증 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  SMOKE_SET_HF_CREDENTIAL=true \
  HF_TOKEN_FILE="$HOME/.huggingface/token" \
  WORKFLOW_FILE=examples/openpi-libero-lora/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

워크플로우가 `cpu: 8`, `memory: 64Gi`, `gpu: 1`을 요청하므로 검증된 경로에는 `g7e.4xlarge`를 사용하십시오.

업스트림 OpenPI 스텝 수 신호에 맞추는 품질 지향의 장기 실행:

```bash
osmo workflow submit examples/openpi-libero-lora/workflow.yaml \
  --pool default \
  -t json \
  --set num_train_steps=30000 \
  --set save_interval=30000 \
  --set norm_stats_max_frames=1024 \
  --set batch_size=1 \
  --set gpu_metrics_interval_seconds=10 \
  --set-string output_dataset=openpi-libero-lora-30k-artifacts \
  --set-string experiment_name=aws-osmo-libero-lora-30k \
  --set-string retain_checkpoint_arrays=true
```

레퍼런스 워크플로우는 단일 GPU E2E 검증 경로입니다. 완전한 pi0.5 LIBERO 벤치마크 재현이 아닙니다.
