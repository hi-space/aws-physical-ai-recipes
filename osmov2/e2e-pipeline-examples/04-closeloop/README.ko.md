# Stage 4 — Closed-Loop 평가

Stage 3 GR00T 체크포인트를 LeIsaac(SO-101 + 주방 씬) Isaac Sim에서 closed-loop으로
평가합니다. 단일 GPU pod가 GR00T ZMQ 정책 서버와 LeIsaac rollout을 함께 실행하며
태스크 성공률을 측정합니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

- OSMO 입력: `e2e-pipeline-groot-checkpoint` (Stage 3 산출물)
- OSMO 출력: `e2e-pipeline-closeloop-artifacts`

## 권장 GPU

이 평가 스테이지는 GR00T 정책 서버 + LeIsaac rollout을 한 pod에서 돌리며
`cpu: 8`, `memory: 90Gi`, `gpu: 1`을 요청합니다 — L40S(48GB) 한 장이면
충분합니다. 권장 노드는 `g6e.4xlarge`(16 vCPU / 128GB)이며, memory 요청 때문에
`g6e.2xlarge`(64GB)는 불가합니다. Karpenter가 pod 요청값을 보고 사이즈를
고릅니다.

## 실행

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.4xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set input_dataset=e2e-pipeline-groot-checkpoint

scripts/wait-gpu-node-cleanup.sh
```

96GB g7e(RTX PRO 6000, `g7e.4xlarge`) 카드에서 돌리려면 g7e 노드를 프리워밍하고
`--set platform=g7e-rtx-pro-6000`을 추가하세요(g7e NodePool은 항상 배포되어
있으므로 재배포가 필요 없습니다):

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-groot-checkpoint
```

## 파라미터 (default-values)

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `input_dataset` | `e2e-pipeline-groot-checkpoint` | Stage 3 체크포인트 데이터셋 |
| `output_dataset` | `e2e-pipeline-closeloop-artifacts` | OSMO 출력 데이터셋 이름 |
| `task_name` | `LeIsaac-SO101-PickOrange-v0` | LeIsaac 평가 태스크 |
| `instruction` | `pick up the orange and place it on the plate` | 언어 instruction |
| `num_episodes` | `5` | 평가 에피소드(`--eval_rounds`) |
| `embodiment_tag` | `NEW_EMBODIMENT` | 체크포인트 학습 config와 일치해야 함 |
| `gr00t_ref` | `e8e625f4…` | GR00T 커밋 — leisaac N1.6 서버 호환 pin |
| `leisaac_ref` | `24d3bcd3…` | LeIsaac 커밋 |
| `policy_action_horizon` / `policy_timeout_ms` / `policy_port` | `16` / `5000` / `5555` | ZMQ 정책 클라이언트 노브 |
| `step_hz` | `30` | 제어 루프 주기 |
| `cpu` / `memory` / `storage` | `8` / `64Gi` / `200Gi` | Pod 리소스 |
| `platform` | `g6e-l40s` | OSMO GPU 플랫폼 (g6e L40S, 권장 `g6e.4xlarge`; 96GB `g7e.4xlarge` 필요시 --set platform=g7e-rtx-pro-6000) |

## N1.6 고정 (N1.7 체이닝 시)

이 스테이지는 N1.6 서버 ref(`gr00t_ref=e8e625f4…`)를 고정하고
`--policy_type gr00tn1.6`을 사용하며, leisaac 공식 N1.6 예제와 일치합니다. 기본
Stage 3 체크포인트(N1.6)는 그대로 동작합니다. 선택적 N1.7
경로(`03-training/workflow-n1.7.yaml`)로 학습했다면, 체이닝 전에 이 스테이지를
N1.7 호환 정책 서버/클라이언트로 오버라이드하세요.

## 출력

- `eval-summary.json` — 성공률, 에피소드 수 (source of truth)
- `logs/server.log`, `logs/rollout.log` — 서버 + rollout 로그

참고: 이 스테이지는 비디오를 내보내지 않습니다. leisaac `policy_inference.py`가
`env_cfg.recorders = None`을 설정하고 `RecordVideo`로 감싸지 않으므로 `videos/`는
비어 있습니다; 성공/실패는 파싱된 rollout 로그("Final success rate")에서 나옵니다.
mp4가 필요하면 `gym.wrappers.RecordVideo` 패치를 추가하세요.

## e2e-workshop 매핑

`groot/inference/run-isaaclab.sh`를 재현합니다: 동일한 LeIsaac 설치, N1.6
language-key 패치, headless-keyboard 패치, `kitchen_with_orange`/`so101_follower`
에셋 — Docker-on-DCV 대신 OSMO가 단일 pod에서 오케스트레이션. 실제
`policy_inference.py` 호출은 leisaac `docs/docs/resources/available_policy.md`와
교차 확인했습니다(워크샵 `run-isaaclab.sh`는 컨테이너를 대화형으로만 기동).

## 관련

독립 예제 [`examples/closed-loop-sim-eval`](../../examples/closed-loop-sim-eval/README.md)는
동일한 서버 + rollout 메커니즘의 RoboCasa GR1 변형이며, G6e/L40S 노드에서 런타임
검증되었습니다(`success rate: 1.0`, 2026-07-27).
