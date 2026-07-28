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

### 런타임과 `num_steps` 노브

L40S 한 장(`g6e.8xlarge`)에서 실측: 774프레임 에피소드 1개는 9개 chunk ×
`num_steps` sampling step으로 처리되어, **기본 `num_steps=35`에서 에피소드당
약 80분**(chunk당 약 8.5분)입니다. 실행 시간은 `num_steps`에 거의 선형이라,
전체 120개 클립을 35 step으로 돌리면(약 160시간) 3일 `exec_timeout` 안에
끝나지 **않습니다**. 시간이 급하면 품질을 속도와 맞바꾸세요:

```bash
# 시간 약 절반(약간의 photorealism 손실), 해상도를 낮추면 chunk당 연산도 감소
osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos \
  --set num_steps=15 --set resolution=480
```

| `num_steps` | 에피소드당 대략 | 용도 |
| --- | --- | --- |
| `35` (기본) | 약 80분 | 학습용 고품질 증강 |
| `15` | 약 35분 | 빠른 반복 / 기능 확인 |
| `10` | 약 23분 | 스모크 실행 |

전체 데이터셋을 학습용 품질로 만들려면 `num_steps=35`를 유지하되 **에피소드
서브셋**만 돌리거나, 여러 GPU로 병렬화하거나, `exec_timeout`을 상향하세요.

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
| `num_steps` | `35` | diffusion sampling step 수 — 시간을 좌우하는 핵심 노브(실행 시간 거의 선형); 시간이 급하면 낮추기(`15`≈절반, `10`≈1/3) |
| `resolution` | `720` | 출력 해상도(`720` 또는 `480`); `480`은 chunk당 연산/VRAM을 줄이지만 화질 저하 |
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
nut-pouring Cosmos 단계와 일치).

### 고정 ref 대조 검증 완료 (2026-07-28)

`cosmos-transfer2.5@0033b77a`를 클론해 `inference.py` / `config.py` 검증을
재현한 소스 레벨 감사:

- [x] edge 스펙 경로. `assets/robot_example/edge/robot_edge_spec.json`(첫 번째
      `SPEC_TEMPLATE` 후보)이 고정 ref에 존재하므로, 워크플로우는 이 템플릿을
      쓰고 최소 폴백을 타지 않습니다.
- [x] 스펙 변형 수정. 배포된 edge 템플릿은 `prompt_path: "../robot_prompt.txt"`와
      `edge.control_path: "robot_edge.mp4"`를 갖는데, 스펙이 `/tmp/cosmos_specs`로
      복사되면 둘 다 존재하지 않는 상대경로가 됩니다. Cosmos는 `os.chdir(spec.parent)`
      후 이들을 `pydantic.FilePath`로 검증하므로, 패치 전 스펙은 두 개의
      `path_not_file` 오류로 실패했습니다(재현 완료). 이제 PYSPEC 블록이
      `prompt_path`를 제거하고(인라인 `prompt` 사용) 모든 control 키를 지운 뒤
      `control_path` 없이 `edge: {control_weight: 1.0}`만 세팅하므로, Cosmos가 RGB
      프레임에서 edge 힌트를 on-the-fly(CannyEdge)로 생성합니다. 패치된 스펙은
      고정 스키마 대조에서 깨끗이 통과합니다.
- [x] `inference.py -i/-o`는 유효한 tyro alias(`input_files` / `output_dir`)입니다.

### GPU 런타임 검증 (2026-07-28)

L40S 한 장(`g6e.8xlarge`, `--set cpu=16 memory=200Gi`)에서 실행. 첫 에피소드가
end-to-end로 완료됐고, 출력 확인 후 실행을 취소했습니다(전체 120개 클립은
`num_steps=35`에서 `exec_timeout`을 초과 — 위 런타임 안내 참고).

- [x] 모델 로드 + diffusion. gated 모델 전부(Cosmos-Transfer2.5-2B,
      Predict2.5-2B, Reason1-7B, Qwen2.5-VL-7B, Wan2.1 VAE) 다운로드·로드됨.
      guardrail의 import 시점 gated 다운로드는 `core.py` 패치 +
      `--disable-guardrails`로 우회되고, edge 힌트는 (control 파일 없이) 온라인
      계산됩니다.
- [x] 프레임 수 / fps 재정렬. 증강 에피소드를 소스 `nb_read_frames` +
      `r_frame_rate`에 맞춰 재인코딩: 출력 mp4가 **774프레임 @ 30fps, 640×480으로
      소스와 완전히 동일**함을 확인 → LeRobot per-episode 인덱싱 유효성 유지.
      `tpad` 복제 후 `-frames:v` 트림이 의도대로 동작합니다.
- [x] Host RAM. diffusion은 5개 모델을 동시 로드하므로 `g6e.8xlarge`(256GB)는
      여유롭지만(약 12GB 사용), `g6e.2xlarge`(64GB)는 diffusion 단계에서 노드가
      OOM 리부팅됩니다. 48GB L40S만이 아니라 host RAM 기준으로 노드를 고르세요.

- [ ] End-to-end: 증강된 데이터셋으로 Stage 3를 실행해 학습이 되는지 확인(아직
      미완 — 증강 단계만 런타임 검증됨).
