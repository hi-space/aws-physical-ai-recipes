# E2E 파이프라인 예제

[e2e-workshop](../../e2e-workshop/)의 전체 physical-AI 파이프라인을 AWS 레퍼런스
아키텍처(`g7e-rtx-pro-6000` 플랫폼, Karpenter, OSMO 데이터셋) 위에서 돌아가는
OSMO 워크플로우로 재패키징한 것입니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다. 상세 원문은 영문
> README를 기준으로 삼으세요.

`examples/`가 단일 목적의 독립 워크플로우를 담는 곳이라면, 이 디렉터리는 순서가
있는 파이프라인입니다: 각 스테이지의 OSMO 출력 데이터셋(output dataset)이 다음
스테이지의 입력 데이터셋(input dataset)으로 이어지므로, 데이터 준비 → 학습 →
closed-loop 평가를 하나의 체인으로 돌리거나 각 스테이지를 단독으로 실행할 수
있습니다.

```
01-data-prep ─▶ (lerobot dataset) ─▶ 03-training ─▶ (checkpoint) ─▶ 04-closeloop
      │              ▲                     │
      │  06-cosmos-augment (선택적)       └──────▶ 05-edge (Greengrass)
      └──────────────┘
02-sim  (독립 RL 트랙)
```

## 스테이지

| 스테이지 | 하는 일 | OSMO 입력 → 출력 |
| --- | --- | --- |
| [01-data-prep](01-data-prep/README.md) | HF에서 LeRobot 데이터셋 다운로드, v3→v2.1 자동 변환, 검증. | — → `e2e-pipeline-lerobot-dataset` |
| [02-sim](02-sim/README.md) | Isaac Lab RL: H1 휴머노이드 보행 학습(PPO), replay + 비디오 녹화. | — → `e2e-pipeline-sim-rl-artifacts` |
| [03-training](03-training/README.md) | 워크샵 SO-101 modality config로 SO-101 데이터셋에 GR00T VLA 파인튜닝. 기본은 N1.6이며, [workflow-n1.7.yaml](03-training/workflow-n1.7.yaml)이 선택적 N1.7 경로. | `e2e-pipeline-lerobot-dataset` → `e2e-pipeline-groot-checkpoint` |
| [04-closeloop](04-closeloop/README.md) | LeIsaac + SO-101 + 주방 씬으로 ZMQ 정책 서버에 대한 closed-loop 평가. | `e2e-pipeline-groot-checkpoint` → `e2e-pipeline-closeloop-artifacts` |
| [05-edge](05-edge/README.md) | 로봇 위에서 GR00T 정책 서버를 돌리는 Greengrass 컴포넌트. | S3 모델 → 온디바이스 서버 |
| [06-cosmos-augment](06-cosmos-augment/README.md) | (선택적) Stage 1 LeRobot 비디오를 Cosmos Transfer 2.5로 photorealistic 증강(edge control, RGB만); Stage 3에 다시 투입. | `e2e-pipeline-lerobot-dataset` → `e2e-pipeline-lerobot-dataset-cosmos` |

## e2e-workshop 매핑

| 이 스테이지 | e2e-workshop 소스 | 주요 적응 사항 |
| --- | --- | --- |
| 01-data-prep | `groot/training/data/{upload_dataset,convert_v3_to_v2}.py` | S3 대신 OSMO 데이터셋에 기록; 변환 로직을 인라인으로 내장. |
| 02-sim | 모듈 2–4, `scripts/reinforcement_learning/skrl/{train,play}.py` | OSMO pod에서 headless 실행; checkpoint + TensorBoard + 비디오를 데이터셋으로 내보냄. |
| 03-training | `infra/groot/assets/{run_finetune_workflow.sh,finetune_gr00t.py,launch_finetune.py}`, `groot/training/data/configs/so101_modality_config.py` | 단일 pod OSMO 태스크; Stage 1 데이터셋 소비; SO-101 modality config. 기본 N1.6(`launch_finetune.py`); N1.7 변형은 `finetune_gr00t.py`의 `experiment.run()` 경로를 인라인. |
| 04-closeloop | `groot/inference/run-isaaclab.sh` | 동일한 LeIsaac 설치 + N1.6 language-key 패치 + headless-keyboard 패치 + kitchen_with_orange/so101_follower 에셋을, Docker-on-DCV 대신 OSMO로 오케스트레이션. |
| 05-edge | `edge/workshop-components/N1.6/com.workshop.{setup,inference}` | 모델을 (CloudFront tarball이 아닌) S3에서; ECR 이미지 파라미터화; TRT는 선택. |
| 06-cosmos-augment | `examples/nut-pouring-pipeline/workflows/03_cosmos_augmentation.yaml` | 동일한 고정 Cosmos Transfer 2.5 ref + tokenizer 패치를 LeRobot per-episode mp4 레이아웃에 맞게 적응; depth 대신 edge control(RGB만). |

## 체인 실행

GPU 스테이지는 OSMO 검증 전에 G7e 용량이 관측 가능해야 합니다:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

# Stage 1 — 데이터 준비 (CPU)
osmo workflow submit e2e-pipeline-examples/01-data-prep/workflow.yaml \
  --set hf_dataset_id=LightwheelAI/leisaac-pick-orange

# Stage 6 (선택적) — Cosmos Transfer 2.5 photorealistic 증강 (GPU).
# 도메인 랜덤화된 학습 프레임이 필요할 때만 삽입; 이후 Stage 3를 Stage 1
# 데이터셋 대신 e2e-pipeline-lerobot-dataset-cosmos로 지정하세요.
osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos

# Stage 3 — 파인튜닝 (Stage 1 출력 소비). 기본은 N1.6.
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000

# Stage 3 (N1.7 변형) — gated Cosmos-Reason2-2B 백본용 HF_TOKEN 필요;
# e2e-pipeline-groot-checkpoint-n17에 기록됨 (N1.7은 Stage 4를 오버라이드해야 함).
osmo workflow submit e2e-pipeline-examples/03-training/workflow-n1.7.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=6000 --set save_steps=2000

# Stage 4 — closed-loop 평가 (Stage 3 출력 소비)
osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set input_dataset=e2e-pipeline-groot-checkpoint

scripts/wait-gpu-node-cleanup.sh
```

Stage 2(RL)는 독립적이라 언제든 실행할 수 있습니다:

```bash
osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml
```

Stage 5(edge)는 Greengrass 배포입니다 — [05-edge/README.md](05-edge/README.md) 참고.

## Isaac Sim 버전 커버리지

기본값은 리포의 stable 핀을 따릅니다:

- Stage 2 / Stage 4: Isaac Lab `2.2.0` (Isaac Sim 4.5.0 시대). 5.1 latest
  스택을 쓰려면 `--set isaac_lab_image=nvcr.io/nvidia/isaac-lab:2.3.0`으로
  오버라이드(메모리를 더 할당).
- Stage 1 / Stage 3: PyTorch `25.03-py3`.

## 이 레시피들의 상태

이 OSMO 레시피들은 e2e-workshop 코드에서 파생되었습니다. 고정된 업스트림
ref(`Isaac-GR00T@ead52833`, `leisaac@24d3bcd3`, tyro `0.9.17`)에 대한 소스 레벨
감사는 2026-07-12에 수행했습니다 — ref를 클론하고 CLI 파싱을 재현하는 방식.
그 감사가 찾은 CLI 결함은 이후 워크플로우 YAML에서 수정되었습니다(아래 "수정됨"
참고). 이 순차 파이프라인의 GPU 전체 end-to-end 런타임 검증은 여전히 진행 중이며,
각 스테이지가 실제로 실행되면 산출물이
`e2e-pipeline-examples/<stage>/validation/` 아래에 쌓여야 합니다.

다만 이 파이프라인이 재사용하는 GR00T 추론 코드 경로(ZMQ 정책 서버 + rollout)는
별도로 런타임 검증되었습니다: 독립 예제
[`examples/closed-loop-sim-eval`](../examples/closed-loop-sim-eval/README.md)
(RoboCasa GR1)가 2026-07-27 G6e/L40S 노드에서 end-to-end 통과했습니다
(`success rate: 1.0`). Stage 4(leisaac SO-101)와는 태스크·embodiment가 다르지만
서버 + rollout 메커니즘은 공유하므로, 그 부분은 이 플랫폼에서 동작함이
확인되었습니다.

### 검증 OK (변경 불필요)

- Stage 1 v3→v2.1 변환은 업스트림 `convert_v3_to_v2.py`와 함수 단위로 일치.
- Stage 3 SO-101 modality config는 업스트림과 동일; import
  (`register_modality_config`, `gr00t/data/types.py`의 5개 심볼)과
  `EmbodimentTag.NEW_EMBODIMENT`가 고정 커밋에 모두 존재.
- `launch_finetune.py`, `run_gr00t_server.py`, 태스크 id
  `LeIsaac-SO101-PickOrange-v0`가 고정 ref에 모두 존재.
- 서버 호출: tyro 0.9.17이 언더스코어와 하이픈 플래그를 모두 허용(재현 완료)해서,
  Stage 4(`--model_path`)와 Stage 5(`--model-path`)가 둘 다 유효.
- Stage 3의 나머지 CLI 플래그도 실제 `FinetuneConfig`에 대해 깔끔하게 파싱됨.

### 수정됨 (2026-07-12)

Stage 3 (`03-training/workflow.yaml`):

- [x] `--use-relative-action` 제거. `FinetuneConfig`에는
      `use_relative_action` 필드가 없어 tyro가 `Unrecognized options`로 종료됨
      (재현 완료). `launch_finetune.py`가 이미
      `config.model.use_relative_action = True`를 하드코딩하므로, 이 플래그와
      `use_relative_action` 노브를 워크플로우에서 제거.

Stage 4 (`04-closeloop/workflow.yaml`) — 평가 커맨드를 leisaac 공식 예제
(`docs/docs/resources/available_policy.md`, N1.6)에 맞춰 수정:

- [x] `--policy_type` → `gr00tn1.6` (기존 `gr00t`는 어떤 분기에도 안 걸림;
      N1.6 경로는 `Gr00t16ServicePolicyClient` 사용).
- [x] 존재하지 않는 플래그 제거: `--num_envs`, `--headless`,
      `--record_video`, `--video_dir`, `--total_episode`; 에피소드 수는 이제
      `--eval_rounds=N`, 그리고 `--enable_cameras`, `--device=cuda`.
- [x] `gr00t_ref` → `e8e625f4f21898c506a1d8f7d20a289c97a52acf`로 변경해
      leisaac N1.6 문서와 일치(N1.6 ZMQ/서버 호환은 커밋에 민감).

### 런타임에서 결정/검증할 항목

- [x] Stage 3 N1.6 vs N1.7 — 두 경로 모두 제공됨. 워크샵의 메인 파인튜닝
      모듈(`infra/groot`)은 `finetune_gr00t.py`(`experiment.run()` API)를 통해
      `nvidia/GR00T-N1.7-3B`를 타깃으로 합니다. N1.6은 기본값으로
      유지(`workflow.yaml`, `launch_finetune.py`, gated 백본 없음, 재현이 더
      쉬움); N1.7은 별도의 선택 경로
      ([workflow-n1.7.yaml](03-training/workflow-n1.7.yaml))로,
      `gr00t_ref=23ace64f…`를 고정하고 `nvidia/GR00T-N1.7-3B`를 사용하며
      업스트림 `finetune_gr00t.py`의 단일 pod 포트를 인라인합니다. N1.7은
      gated `nvidia/Cosmos-Reason2-2B` 백본에 접근 가능한 `HF_TOKEN`이
      필요합니다. 체이닝 주의: N1.7 체크포인트는 Stage 4에서 N1.7 호환
      서버/정책 클라이언트를 요구하는데, Stage 4는 현재 N1.6 `gr00t_ref` +
      `--policy_type gr00tn1.6`을 고정하고 있으므로 N1.7 체이닝 전 Stage 4를
      오버라이드하세요.
- [ ] Stage 3 `max_steps`/`save_steps`가 매우 작음(스모크 체크). 정책 품질
      런에서는 값을 키우세요.
- [ ] Stage 4는 비디오를 내보내지 않음. `policy_inference.py`가
      `env_cfg.recorders = None`을 설정하고 `RecordVideo`로 감싸지 않으므로
      mp4가 생성되지 않습니다. 성공/실패는 rollout 로그에서 나오며, `videos/`
      출력은 `gym.wrappers.RecordVideo` 패치를 추가하지 않는 한 비어 있습니다.

참고 — leisaac 공식 N1.6 예제(Stage 4의 목표 형태):

```shell
python scripts/evaluation/policy_inference.py \
    --task=LeIsaac-SO101-PickOrange-v0 \
    --eval_rounds=10 \
    --policy_type=gr00tn1.6 \
    --policy_host=localhost --policy_port=5555 \
    --policy_timeout_ms=5000 --policy_action_horizon=16 \
    --policy_language_instruction="Pick up the orange and place it on the plate" \
    --device=cuda --enable_cameras
```

### 노트

- Stage 4의 `run-isaaclab.sh` 원본은 컨테이너를 대화형으로만 기동합니다(Step 6);
  실제 `policy_inference.py` 커맨드는 외부 워크샵 가이드(모듈 8)에 있었기 때문에,
  위 leisaac 문서와 교차 확인이 필요했습니다.
- 리포 컨벤션을 따르세요: 검증 산출물은
  `e2e-pipeline-examples/<stage>/validation/` 아래에 `validation.md`와 함께
  보관합니다.
