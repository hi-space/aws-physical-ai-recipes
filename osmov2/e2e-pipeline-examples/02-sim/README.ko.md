# Stage 2 — Sim / RL

강화학습 트랙: Isaac Lab(skrl PPO)으로 H1 휴머노이드가 거친 지형을 걷도록
학습시키고, 학습된 정책을 replay하며 비디오를 녹화합니다. 이 스테이지는 GR00T
VLA 체인(Stage 1/3/4/5)과 독립적입니다 — 그들의 데이터셋을 주고받지 않습니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

- OSMO 입력: 없음
- OSMO 출력: `e2e-pipeline-sim-rl-artifacts` (checkpoint + TensorBoard + 비디오)

## 실행

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml

scripts/wait-gpu-node-cleanup.sh
```

Isaac Sim 5.1 스택을 쓰려면 이미지를 오버라이드하세요(메모리를 더 할당):

```bash
osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml \
  --set isaac_lab_image=nvcr.io/nvidia/isaac-lab:2.3.0
```

## 파라미터 (default-values)

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `task_name` | `Isaac-Velocity-Rough-H1-v0` | Isaac Lab task/env id |
| `rl_framework` | `skrl` | RL 프레임워크 |
| `train_num_envs` | `2048` | 학습 시 병렬 env 수 |
| `play_num_envs` | `32` | replay 시 병렬 env 수 |
| `max_iterations` | `1000` | PPO 학습 iteration |
| `video_length` | `400` | replay 비디오 길이(스텝) |
| `isaac_lab_image` | `nvcr.io/nvidia/isaac-lab:2.2.0` | Isaac Lab 이미지(`2.3.0` = Isaac Sim 5.1) |
| `output_dataset` | `e2e-pipeline-sim-rl-artifacts` | OSMO 출력 데이터셋 이름 |

## 출력

- 학습된 skrl 체크포인트
- TensorBoard 이벤트 로그
- replay 비디오(`play_num_envs` env, `video_length` 스텝)

## e2e-workshop 매핑

워크샵 모듈 2–4와 `scripts/reinforcement_learning/skrl/{train,play}.py`를
적응한 것입니다. OSMO pod에서 headless로 실행하고 체크포인트, TensorBoard 로그,
비디오를 하나의 데이터셋으로 내보냅니다.
