# Closed-Loop Sim Eval

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

GR00T policy를 Isaac Sim 환경에서 closed-loop으로 평가하는 워크플로우. 단일 GPU pod 안에서 추론 서버(ZMQ)와 시뮬레이션 rollout을 동시에 실행하여 학습된 VLA 모델의 task 성공률을 측정합니다.

아키텍처:

```
┌─────────────────────────────────────────────────────┐
│  OSMO Workflow Pod (single GPU)                     │
│                                                     │
│  ┌─────────────────────┐   ZMQ REQ/REP             │
│  │ rollout_policy.py   │◄──────────────►┐          │
│  │ (Isaac Sim env +    │   observation   │          │
│  │  policy client)     │   → action      │          │
│  └─────────────────────┘                 │          │
│                                          │          │
│  ┌─────────────────────┐                 │          │
│  │ run_gr00t_server.py │◄────────────────┘          │
│  │ (GR00T inference)   │                            │
│  │ model: /tmp/weights │                            │
│  └─────────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

워크플로우 파일:

| 파일 | Isaac Lab / Sim | 플랫폼 | 메모리 | 비고 |
| --- | --- | --- | --- | --- |
| `workflow.yaml` | 2.2.0 (Isaac Sim 4.5.0) | `g7e-rtx-pro-6000` | 64Gi | stable |
| `workflow-5.1.yaml` | 2.3.0 (Isaac Sim 5.1.0) | `g7e-rtx-pro-6000` | 96Gi | latest |
| `workflow-g6e.yaml` | 2.2.0 (Isaac Sim 4.5.0) | `g6e-l40s` | 90Gi | G6e(L40S) 용량 fallback; 런타임 검증 완료 |

Isaac Lab 2.x 버전 매핑: 2.2.0 = Isaac Sim 4.5.0(stable), 2.3.0 = Isaac Sim
5.1.0(latest). Isaac Sim 5.0.0(Isaac Lab 2.2.x 계열)은 별도 워크플로우를 두지
않습니다 — 5.0은 5.1로 빠르게 대체된 과도기 릴리스라 e2e-workshop과 동일하게
4.5/5.1 두 프로필만 유지합니다.

검증 상태: 2026-07-27 g6e(L40S) fallback에서 end-to-end 런타임 검증 통과
(`success rate: 1.0`, 1 episode). g7e 용량이 없어 g6e로 검증했으며 코드 경로는
동일합니다. 상세 및 런타임에서 발견/수정한 deepspeed 결함은
[validation.md](validation.md) 참고.

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh

# stable (Isaac Sim 4.5.0)
osmo workflow submit examples/closed-loop-sim-eval/workflow.yaml

# latest (Isaac Sim 5.1.0)
osmo workflow submit examples/closed-loop-sim-eval/workflow-5.1.yaml

# G6e(L40S) capacity fallback (when g7e is unavailable)
DEPLOY_G6E_NODEPOOL=true scripts/deploy-karpenter.sh
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-osmo.sh
GPU_PREWARM_INSTANCE_TYPE=g6e.4xlarge KARPENTER_NODEPOOL_NAME=aws-osmo-g6e \
  scripts/prewarm-gpu-node.sh
osmo workflow submit examples/closed-loop-sim-eval/workflow-g6e.yaml
```

정리(Cleanup):

```bash
scripts/wait-gpu-node-cleanup.sh
```

## Parameters

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `model_path` | `nvidia/GR00T-N1.6-3B` | HuggingFace 모델 ID 또는 경로 |
| `embodiment_tag` | `GR1` | 로봇 embodiment 태그 (평가 환경과 반드시 일치해야 함) |
| `env_name` | `gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env` | RoboCasa GR1 tabletop 평가 환경 |
| `n_episodes` | 5 | 평가 에피소드 수 |
| `n_action_steps` | 8 | 추론 호출당 액션 스텝 수 |
| `n_envs` | 1 | 병렬 환경 수 (pod 메모리가 충분한 경우에만 늘릴 것) |
| `max_episode_steps` | 720 | 에피소드당 최대 스텝 수 |

## Fine-tuned model evaluation

학습 완료된 모델을 평가하려면 `model_path`를 커스텀 모델 경로로 오버라이드
(`embodiment_tag`는 반드시 평가 env와 일치해야 함):

```bash
osmo workflow submit examples/closed-loop-sim-eval/workflow.yaml \
  --set model_path=<your-hf-model-id-or-s3-path>
```

## Available environments

RoboCasa GR1 tabletop 벤치마크(24개 태스크)의 gym env id. 전체 목록과
레퍼런스 성공률은 Isaac-GR00T `examples/robocasa-gr1-tabletop-tasks/README.md`
참조. 예:

| 환경 | 로봇 |
| --- | --- |
| `gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env` | GR1 |
| `gr1_unified/PnPCanToDrawerClose_GR1ArmsAndWaistFourierHands_Env` | GR1 |
| `gr1_unified/PosttrainPnPNovelFromPlateToPlateSplitA_GR1ArmsAndWaistFourierHands_Env` | GR1 |

## Outputs

- `eval-summary.json` — 성공률, 에피소드 수, 비디오 목록
- `videos/` — 에피소드별 rollout 녹화 mp4
- `logs/server.log` — 추론 서버 로그
- `logs/rollout.log` — rollout 실행 로그

## Comparison with e2e-workshop

`e2e-workshop/groot/inference/run-isaaclab.sh`는 GPU EC2 위에서 Docker + systemd 기반으로 동일 평가를 수행합니다. 이 OSMO 워크플로우는 동일한 로직을 OSMO 오케스트레이터에서 submit-and-forget으로 실행할 수 있게 패키징한 것입니다. 주요 차이:

| | e2e-workshop | osmov2 (이 예제) |
| --- | --- | --- |
| 인프라 | CDK GPU EC2 + systemd | OSMO + Karpenter G7e |
| 서버 라이프사이클 | 상시 실행 (systemd) | 워크플로우 범위 (동일 pod) |
| 모델 전달 | EFS 사전 다운로드 | 런타임에 HF snapshot_download |
| 평가 트리거 | 수동 (ssh + script) | `osmo workflow submit` |
| 아티팩트 | 로컬 디스크 | OSMO dataset output |
