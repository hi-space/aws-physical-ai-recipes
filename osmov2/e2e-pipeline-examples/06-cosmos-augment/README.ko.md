# Stage 6 — Cosmos Transfer 2.5 시각 증강 (선택적)

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

Stage 1 LeRobot 데이터셋을
[Cosmos Transfer 2.5](https://github.com/nvidia-cosmos/cosmos-transfer2.5)로
photorealistic하게 증강한 뒤, 증강된 데이터셋을 Stage 3 파인튜닝에 투입합니다.
이 단계는 선택적 중간 단계입니다 — 기본 체인은 Stage 1 → Stage 3이며, sim-to-real
갭을 줄이기 위해 도메인 랜덤화된 photorealistic 학습 프레임이 필요할 때만 이
단계를 끼워 넣으세요.

- OSMO 입력: `e2e-pipeline-lerobot-dataset` (Stage 1 산출물)
- OSMO 출력: `e2e-pipeline-lerobot-dataset-cosmos`

## 체인에서의 위치

```
01-data-prep ─▶ (lerobot dataset) ─▶ 03-training
                     │
                     └▶ 06-cosmos-augment ─▶ (augmented lerobot dataset) ─▶ 03-training
```

LeRobot 레이아웃의 카메라별 per-episode mp4
(`videos/chunk-XXX/<video_key>/episode_XXXXXX.mp4`)를 각각 Cosmos Transfer로
다시 렌더링해 동일한 상대 경로에 제자리(in place)로 덮어씁니다. 따라서 출력은
그대로 쓸 수 있는 LeRobot 데이터셋이며, Stage 3는 `--set input_dataset=…`만
바꾸면 그대로 소비합니다.

## Edge control (RGB만)

nut-pouring의 Cosmos 단계(`examples/nut-pouring-pipeline`)는 depth control을
쓰지만, 그 파이프라인은 MimicGen sim에서 영상을 생성하므로 conditioning에 쓸
depth mp4가 있습니다. e2e Stage 1 데이터셋은 실제 teleoperation LeRobot
데이터(`front`/`wrist` RGB, depth 없음)이므로 이 단계는 edge control을 사용합니다:
Cosmos가 RGB 프레임 자체에서 edge/구조 힌트를 추출하므로 별도 depth 생성 단계가
필요 없습니다. 나중에 depth 패스를 추가한다면 `--set control_mode=depth`로
전환하세요.

## 권장 GPU

이 스테이지가 가장 무겁습니다: `cpu: 30`, `memory: 128Gi`, `gpu: 1`을
요청합니다. 권장 노드는 `g6e.12xlarge`(48 vCPU / 384GB)입니다 — `cpu: 30`
요청은 DaemonSet 오버헤드를 빼면 `g6e.8xlarge`(32 vCPU)에 안 들어가므로, 이
스테이지만 더 큰 g6e 사이즈가 필요합니다. GPU는 여전히 L40S(48GB) 한 장이지만,
Cosmos는 해상도/프레임 수가 높을 때 48GB에서 OOM이 날 수 있는 diffusion
워크로드입니다 — 그럴 경우 아래 g7e 안내를 참고하세요.

## 실행

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.12xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos

# 이후 Stage 3를 증강된 데이터셋으로 지정
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset-cosmos \
  --set max_steps=10000 --set save_steps=10000

scripts/wait-gpu-node-cleanup.sh
```

Cosmos Transfer는 무거운 diffusion 워크로드입니다 — `exec_timeout`이 3일이며,
런타임은 에피소드/프레임 수에 비례합니다. 작은 데이터셋으로 시작하세요.

Cosmos는 해상도/프레임 수가 높을 때 기본 48GB g6e 카드에서 OOM이 날 수 있습니다.
96GB g7e(RTX PRO 6000, `g7e.12xlarge`) 카드에서 돌리려면 g7e 노드를 프리워밍하고
`--set platform=g7e-rtx-pro-6000`을 추가하세요(g7e NodePool은 항상 배포되어
있으므로 재배포가 필요 없습니다):

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.12xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos
```

## 파라미터 (default-values)

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `input_dataset` | `e2e-pipeline-lerobot-dataset` | Stage 1 LeRobot 데이터셋 |
| `output_dataset` | `e2e-pipeline-lerobot-dataset-cosmos` | 증강 데이터셋 이름 |
| `control_mode` | `edge` | Cosmos control 힌트 (RGB만이면 `edge`; depth를 추가하면 `depth`) |
| `prompt` | `A robot arm … photorealistic kitchen …` | 증강을 유도하는 텍스트 프롬프트 |
| `cosmos_transfer_ref` | `0033b77a…` | 고정된 `cosmos-transfer2.5` 커밋 (`versions.yaml` 기준) |
| `tokenizer_revision_from` / `tokenizer_revision_to` | `6787e176…` / `f176dc95…` | Cosmos Predict tokenizer revision 패치 |
| `cpu` / `memory` / `storage` | `30` / `128Gi` / `200Gi` | Pod 리소스 |
| `platform` | `g6e-l40s` | OSMO GPU 플랫폼 (g6e L40S, cpu:30 요청 때문에 권장 `g6e.12xlarge`; 96GB `g7e.12xlarge` 필요시 --set platform=g7e-rtx-pro-6000) |

## 출력

- `artifacts/dataset/` — 증강된 LeRobot 데이터셋 (Stage 1과 동일 레이아웃)
- `artifacts/augmentation-manifest.json` — control 모드, 증강된 비디오 수, 소스
  codebase 버전 / 에피소드 수 / fps

## nut-pouring 매핑

이 단계는 `examples/nut-pouring-pipeline/workflows/03_cosmos_augmentation.yaml`을
e2e LeRobot 레이아웃에 맞게 적응한 것입니다(동일한 `cosmos-transfer2.5` ref +
tokenizer 패치, 동일한 `cosmos-predict2-container:1.2` 이미지). 두 가지가
다릅니다: LeRobot `videos/…/episode_*.mp4` per-episode 파일을 대상으로
동작하며(flat `demo_*_robot_pov_cam.mp4`가 아님), leisaac 데이터셋에 depth
비디오가 없으므로 depth 대신 edge control을 사용합니다.

## 런타임에서 검증할 항목

이 단계의 소스 레벨 형태는 정확합니다(LeRobot 탐색 + 제자리 mp4 교체가 Stage 3 /
nut-pouring Cosmos 단계와 일치). 다만 다음은 GPU 런타임 검증이 남아 있습니다:

- [ ] 고정 ref에서의 정확한 Cosmos Transfer 2.5 edge 스펙 asset 경로/스키마.
      워크플로우는 몇 개의 후보 스펙 템플릿을 탐색하고 없으면 최소 edge 스펙으로
      폴백합니다; 고정 repo의 `assets/robot_example`와 대조해 필요하면
      `SPEC_TEMPLATE`을 조정하세요.
- [ ] 프레임 수 / fps 재정렬: 증강 클립을 소스 `nb_read_frames` +
      `r_frame_rate`에 맞춰 재인코딩해 LeRobot per-episode 인덱싱이 유효하게
      유지됩니다. Cosmos가 프레임 수를 보존하는지(또는 재인코딩이 복원하는지)
      확인해 `meta/episodes.jsonl` length가 여전히 일치하는지 검증하세요.
- [ ] End-to-end: 증강된 데이터셋으로 Stage 3를 실행해 학습이 되는지 확인하세요.
