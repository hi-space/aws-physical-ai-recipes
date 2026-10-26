# examples: 학습·평가 스크립트

> English: [README.md](README.md)

Job 이 실제로 실행하는 스크립트들이다. 실행 방법은 `k8s-templates/`(EKS)와
`slurm-templates/`(Slurm) 두 가지이고, 둘 다 여기 있는 같은 파일을 호출한다. 그래서 한 번 고치면
두 경로에 함께 반영된다.

```
examples/rl/      강화학습 — GPU 는 Isaac Lab, CPU 는 MuJoCo
examples/vla/     vision-language-action — GR00T 파인튜닝, 평가, 승급 게이트
examples/mlflow/  독립 실행 추적 예시 하나
```

## VLA 루프

순서대로 돈다. 각 단계의 산출물이 다음 단계의 입력이다.

```
download_dataset.py  →  prepare_dataset.py  →  mlflow_run_dir.py  →  train_groot.py
                                                                          ↓
                                                              register_groot_model.py
                                                                          ↓
                           verify_in_sim.py  또는  policy_server.py + eval_closed_loop.py
                                                                          ↓
                                            eval_report.py  →  gate_checkpoint.py
                                                                          ↓
                                                            PROMOTE / PASS / BLOCK
```

파일을 읽기 전에 알아 둘 것이 두 가지 있다.

체크포인트는 고정 경로가 아니라 **MLflow run 자신의 artifact 디렉터리 안에** 쓰인다.
`mlflow_run_dir.py` 가 학습 전에 run 을 만들고 체크포인트가 갈 경로를 출력하므로, 9 GB 를 복사하지
않고도 Artifacts 탭에서 가중치를 열 수 있다. 두 학습 경로가 모두 이것을 호출한다. `OUTPUT_DIR` 이
추적을 껐을 때만 쓰이는 이유가 이것이다.

게이트가 있어야 평가 결과에 구속력이 생긴다. `gate_checkpoint.py` 는 BLOCK 이면 0 이 아닌 값으로
끝나므로, 평가에 실패한 체크포인트 위에서 뒤 단계가 돌지 않는다. 이것이 없으면 평가 결과는 쓰이기만
하고 읽히지 않는다.

## examples/vla

| 파일 | 역할 |
|---|---|
| `download_dataset.py` | GR00T 호환 데이터셋을 받는다. Isaac-GR00T 저장소의 내장 데모셋이거나, HuggingFace 의 LeRobot v2 데이터셋 (`--name`, `--repo-id`) |
| `prepare_dataset.py` | LeRobot v2 구조를 검증하고, GR00T 가 요구하지만 데이터셋에 없을 수 있는 메타데이터 파일을 생성한다 (`--validate`, `--generate-tasks`, FSx DRA import 용 `--upload-s3`) |
| `mlflow_run_dir.py` | 학습 전에 MLflow run 을 만들고 호출자가 `eval` 할 `MLFLOW_RUN_ID` / `CKPT_DIR` 을 출력한다. Trainer 가 아니라 여기서 run 을 만드는 이유는, HF Trainer 의 `MLflowCallback` 은 `train()` 이 시작된 뒤에야 run id 를 알고 그때는 출력 경로로 쓰기에 이미 늦기 때문이다 |
| `train_groot.py` | Isaac-GR00T 의 `launch_finetune.py` 를 MLflow 추적과 함께 감싼다. `GROOT_VERSION` 으로 n1.6 / n1.7 과 해당 베이스 모델을 고른다 |
| `train_pi0.py` | DDP 를 쓰는 π0 파인튜닝 최소 예시. 학습만 있다 — π0 서빙 경로가 아직 없어 `policy_server.py` 로는 평가할 수 없다 |
| `register_groot_model.py` | 체크포인트를 MLflow model version 으로 등록하고 FSx 위치를 태그로 남긴다. `source` 는 `s3://` URI 이고 업로드는 하지 않는다 — FSx DRA 가 같은 바이트를 이미 내보내고 있기 때문이다. 승급은 일부러 하지 않는다. 그건 `gate_checkpoint.py` 의 일이다 |
| `verify_in_sim.py` | Open-loop 평가. held-out 궤적에서 예측 action 과 정답을 비교한다. Isaac Sim 없이 GPU 노드에서 돌기 때문에 값싼 1차 필터가 된다 |
| `policy_server.py` | 파인튜닝한 GR00T 모델을 ZMQ REQ/REP(msgpack)로 서빙하고 16-step action chunk 를 돌려준다. GR00T 만 로드한다 |
| `eval_closed_loop.py` | 정책을 Isaac Sim 에서 돌린다. 정책을 직접 로드하거나, 시뮬레이터와 GPU 가 다른 노드에 있을 때는 `policy_server.py` 를 통해 원격으로 쓴다 |
| `eval_report.py` | 시도 단위 기록을 모아 `eval-report.json` 을 만든다. part 별·시나리오별 분해, Wilson 95% 구간, 두 체크포인트를 구별하는 데 필요한 표본 수까지 담는다. 분해를 남기는 이유는 집계 성공률이 행동 가능한 신호를 가리기 때문이다 — *모든* 시도에서 실패하는 part 는 간헐적으로 실패하는 part 와 다른 문제다 |
| `gate_checkpoint.py` | 리포트를 PROMOTE / PASS / BLOCK 으로 바꾸고 BLOCK 이면 0 이 아닌 값으로 끝난다. Model Registry alias 를 옮길 수도 있다. [`vla/eval_trials/README.md`](vla/eval_trials/README.md) 참고 |
| `vla/eval_trials/` | fixture: 2026-10-22 실로봇 시도 48건. 하드웨어 없이 게이트를 돌려 볼 수 있다 |

지표가 둘이면 권한도 둘이다. 태스크 성공으로 만든 리포트(`metric: success_rate`)는 승급할 수 있다.
open-loop action MSE 로 만든 리포트(`metric: openloop_mse`)는 차단만 할 수 있다 — 그것은 태스크
성공 여부가 아니라 시연을 얼마나 그대로 재현하는지를 재는 값이다.

## examples/rl

| 파일 | 역할 |
|---|---|
| `train_isaaclab.py` | Isaac Lab 에서 rsl_rl 로 PPO 학습. GPU 노드에서 headless 로 돌며 한 프로세스가 수천 개의 팔을 시뮬레이션한다. `model_best.pt` 와 `best_checkpoint.json` 도 쓴다 — PPO 의 평균 보상은 학습 후반에 진동하므로 마지막 체크포인트가 최선이 아니다 |
| `play_isaaclab.py` | 체크포인트를 몇 개의 렌더링 환경에서 DCV 세션으로 재생해 사람이 팔의 동작을 볼 수 있게 한다 |
| `train_mujoco.py` | CPU 대응본. 코어마다 MuJoCo 환경 하나를 별도 프로세스(`SubprocVecEnv`)로 띄워 rollout 을 모아 PPO 업데이트 한 번으로 묶는다. Stable-Baselines3 + VecNormalize. Gymnasium MuJoCo task id 면 무엇이든 동작하므로 빠른 smoke test 로도 쓴다 |
| `play_mujoco.py` | 결정론적 평가(성공률, 최종 거리)와 MuJoCo 소프트웨어 렌더러를 통한 오프스크린 mp4/gif. GPU 도 디스플레이도 필요 없다. `--untrained` 는 학습 전 정책을 렌더해 비교 영상을 만든다 |
| `mlflow_isaaclab.py` | Isaac Lab 의 TensorBoard 스칼라를 실시간으로 MLflow 에 미러링한다. `MLFLOW_TRACKING_URI` 가 비어 있으면 no-op 이고 그게 기본값이다 — 추적은 opt-in 이다 |
| `ray_config.yaml` | Ray on Slurm 클러스터 구성 (head / worker 파티션) |

태스크는 `Workshop-SO101-Reach-v0`(5-DOF 팔이 무작위 목표에 도달)과
`Workshop-SO101-Lift-v0`(팔 + 그리퍼, 테이블 위 목표)이다. MuJoCo 경로는
`Workshop-SO101-Reach-MuJoCo-v0` 를 쓴다.

## examples/mlflow

| 파일 | 역할 |
|---|---|
| `example_tracking.py` | RL 과 VLA 두 형태를 모두 담은 독립 실행 MLflow 추적 예시. 실제 Job 을 띄우기 전에 추적 서버에 닿는지 확인할 때 쓴다 |

## 실행 환경

여기 있는 것은 시스템 Python 으로 돌지 않는다. 경로마다 FSx 에 자기 venv 가 있고, setup 스크립트가
한 번 만들어 두면 이후 모든 Job 이 공유한다.

```
/fsx/envs/gr00t      scripts/setup_groot_env.sh      VLA     (+ scripts/patch_groot_repo.py)
/fsx/envs/mujoco     scripts/setup_mujoco_env.sh     RL CPU
Isaac Lab 컨테이너    nvcr.io/nvidia/isaac-lab:2.3.0  RL GPU
```

`scripts/patch_groot_repo.py` 는 고정된 Isaac-GR00T 체크아웃에 패치를 입힌다. 그중 하나는 Trainer 가
MLflow·TensorBoard 에 지표를 보내게 하는 것이다 — 워크숍은 `--no-use-wandb` 로 돌고 upstream 은
그대로 두면 loss 를 stdout 에만 남긴다.
