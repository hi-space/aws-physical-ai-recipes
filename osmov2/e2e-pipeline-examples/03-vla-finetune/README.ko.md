# Stage 3 — GR00T VLA 파인튜닝

Stage 1이 만든 LeRobot 데이터셋에 GR00T Vision-Language-Action 정책을 워크샵
SO-101 modality config로 파인튜닝합니다. 기본적으로 g6e(NVIDIA L40S, 48GB)
노드에서 단일 pod OSMO 태스크로 실행됩니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

- OSMO 입력: `e2e-pipeline-lerobot-dataset` (Stage 1 산출물)
- OSMO 출력: `e2e-pipeline-groot-checkpoint` (Stage 4가 소비 / Stage 5용으로 S3에 export)

## 두 가지 학습 경로: N1.6(기본) vs N1.7(선택)

워크샵은 두 개의 GR00T 파인튜닝 모듈을 제공합니다. 이 스테이지는 둘 다 제공하니
하나를 고르세요.

| | `workflow.yaml` (기본) | `workflow-n1.7.yaml` (선택) |
| --- | --- | --- |
| GR00T 버전 | N1.6 | N1.7 |
| Base model | `nvidia/GR00T-N1.6-3B` | `nvidia/GR00T-N1.7-3B` |
| Backbone | Eagle (`nvidia/Eagle-Block2A-2B-v2`) | Cosmos-Reason2-2B (게이트) |
| 학습 엔트리 | `launch_finetune.py` | `finetune_gr00t.py` (`experiment.run()`) |
| `Isaac-GR00T` ref | `ead52833…` | `23ace64f…` |
| `HF_TOKEN` | 불필요 | 필수 (게이트 백본) |
| 출력 데이터셋 | `e2e-pipeline-groot-checkpoint` | `e2e-pipeline-groot-checkpoint-n17` |

N1.6이 기본인 이유는 재현이 더 쉽기 때문입니다 — 게이트 백본이 없고 HF 접근도
필요 없습니다. N1.7은 워크샵의 메인 파인튜닝 모듈(`e2e-workshop/infra/groot`)을
그대로 반영하며 `experiment.run()` API로 N1.7을 타깃합니다. 그 의도를 정확히
맞추고 싶을 때 사용하세요.

### N1.7은 Hugging Face 토큰이 필요

N1.7 백본 `nvidia/Cosmos-Reason2-2B`는 게이트된 Hugging Face 저장소입니다. 모델
페이지에서 접근 권한을 받은 뒤, pod가 다운로드할 수 있도록 토큰을 워크플로우와
함께 전달하세요. `HF_TOKEN`이 없으면 워크플로우가 조기 종료됩니다.

### N1.7 체이닝 주의 (Stage 4)

Stage 4(`04-closeloop`)는 현재 N1.6 서버 ref(`gr00t_ref=e8e625f4…`)와
`--policy_type gr00tn1.6`을 고정하고 있습니다. N1.7 체크포인트는 N1.7 호환
정책 서버/클라이언트가 필요하므로, N1.7 체크포인트를 closed-loop 평가로
체이닝하기 전에 Stage 4를 오버라이드해야 합니다. 기본 N1.6 경로는 변경 없이
Stage 4로 이어집니다.

## 권장 GPU

이 VLA 파인튜닝은 `cpu: 16`, `memory: 96Gi`, `gpu: 1`을 요청합니다. 기본 N1.6
3B 모델은 `global_batch_size: 1`에서 L40S(48GB) 한 장에 들어갑니다. 권장 노드는
`g6e.8xlarge`(32 vCPU / 256GB)입니다 — DaemonSet 오버헤드를 빼면 16 vCPU
노드(`g6e.4xlarge`)에는 allocatable 16 vCPU가 깔끔하게 남지 않아 pod가 한 단계
위 사이즈에 뜹니다. N1.7이나 48GB에서 OOM 위험이 있는 큰 `global_batch_size`는
96GB `g7e.8xlarge`를 쓰세요(아래 참고).

## 실행

GPU 스테이지는 OSMO 검증 전에 g6e 용량이 관측 가능해야 합니다:

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge scripts/prewarm-gpu-node.sh

# N1.6 (기본)
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000

# N1.7 (선택) — 게이트 Cosmos-Reason2-2B 백본용 HF_TOKEN 필요
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow-n1.7.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=6000 --set save_steps=2000

scripts/wait-gpu-node-cleanup.sh
```

96GB g7e(RTX PRO 6000, `g7e.8xlarge`) 카드에서 돌리려면 — 예를 들어
`global_batch_size`를 키우거나, N1.7의 게이트 백본이 48GB에서 OOM 위험이 있을 때
— g7e 노드를 프리워밍하고 `--set platform=g7e-rtx-pro-6000`을 추가하세요(g7e
NodePool은 항상 배포되어 있으므로 재배포가 필요 없습니다):

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000
```

기본 `max_steps`/`save_steps`(10/10)는 스모크 값 — 파이프라인이 도는지만
증명하는 용도입니다. 정책 품질 체크포인트를 원하면 값을 키우세요(위 예시 또는
워크샵의 ~6000).

## 파라미터 (default-values)

| 파라미터 | N1.6 기본 | N1.7 기본 | 설명 |
| --- | --- | --- | --- |
| `input_dataset` | `e2e-pipeline-lerobot-dataset` | 동일 | Stage 1 출력 데이터셋 |
| `output_dataset` | `e2e-pipeline-groot-checkpoint` | `…-checkpoint-n17` | 체크포인트 데이터셋 |
| `base_model_path` | `nvidia/GR00T-N1.6-3B` | `nvidia/GR00T-N1.7-3B` | HF base 모델 |
| `gr00t_ref` | `ead52833…` | `23ace64f…` | `Isaac-GR00T` 커밋 |
| `embodiment_tag` | `NEW_EMBODIMENT` | 동일 | modality config와 일치해야 함 |
| `max_steps` / `save_steps` | `10` / `10` | `10` / `10` | 스모크 기본값; 실제 런은 키우기 |
| `global_batch_size` | `1` | `1` | GPU 메모리 여유 시 증가 |
| `learning_rate` | `1e-4` | `1e-4` | |
| `platform` | `g6e-l40s` | 동일 | OSMO GPU 플랫폼 (g6e L40S, 권장 `g6e.8xlarge`; 96GB `g7e.8xlarge` 필요시 --set platform=g7e-rtx-pro-6000) |

## 출력

- `artifacts/` — 학습된 체크포인트(HF 포맷), 출력 데이터셋으로 복사됨
- `artifacts/gpu-metrics/` — `nvidia-smi` 샘플 + 사용률 플롯
- `artifacts/run-manifest.json` — 모델, 버전, 학습 API, 런타임

## e2e-workshop 매핑

- N1.6 기본은 `launch_finetune.py`(`use_relative_action = True`를 하드코딩)를
  `groot/training/data/configs/so101_modality_config.py`의 SO-101 modality
  config와 함께 재현합니다.
- N1.7 선택은 `infra/groot/assets/finetune_gr00t.py`의 단일 pod 포트를
  인라인합니다: `experiment.run()` API와 인플레이스 데이터셋 패칭(modality.json
  annotation 키, parquet `task_description` 컬럼, `stats.json`). 업스트림
  EFS/S3/HF-upload 및 멀티노드 Batch 오케스트레이션은 제거 — OSMO가 데이터셋
  I/O를 처리하고 단일 pod / 단일 GPU에서 돕니다.
