# Closed-Loop Sim Eval

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

Two workflow files:

| File | Isaac Lab / Sim | Memory | Notes |
| --- | --- | --- | --- |
| `workflow.yaml` | 2.2.0 (Isaac Sim 4.5.0) | 64Gi | stable |
| `workflow-5.1.yaml` | 2.3.0 (Isaac Sim 5.1.0) | 96Gi | latest |

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
```

Cleanup:

```bash
scripts/wait-gpu-node-cleanup.sh
```

## Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `model_path` | `nvidia/GR00T-N1.6-3B` | HuggingFace model ID or path |
| `embodiment_tag` | `GR1` | Robot embodiment tag (must match the env) |
| `env_name` | `gr1_unified/PnPBottleToCabinetClose_GR1ArmsAndWaistFourierHands_Env` | RoboCasa GR1 tabletop eval environment |
| `n_episodes` | 5 | Number of evaluation episodes |
| `n_action_steps` | 8 | Action steps per inference call |
| `n_envs` | 1 | Parallel envs (raise only with more pod memory) |
| `max_episode_steps` | 720 | Max steps per episode |

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

| Environment | Robot |
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
| Infra | CDK GPU EC2 + systemd | OSMO + Karpenter G7e |
| Server lifecycle | always-on (systemd) | workflow-scoped (같은 pod) |
| Model delivery | EFS pre-download | HF snapshot_download at runtime |
| Eval trigger | 수동 (ssh + script) | `osmo workflow submit` |
| Artifacts | 로컬 디스크 | OSMO dataset output |
