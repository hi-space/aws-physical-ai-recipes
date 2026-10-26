# k8s-templates: HyperPod EKS Job 템플릿 (워크숍 모듈 9~11)

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다. 상세 원문은 영문 README를 기준으로 삼으세요.

Slurm 경로의 `slurm-templates/` 에 대응한다. `render.sh` 가 `${VAR}` 를 채워 `kubectl apply` 한다.

```bash
./render.sh fsx-pvc.yaml --apply                                   # rl 네임스페이스에 /fsx PV+PVC (FSx 정보는 스택 Output)
./render.sh setup/workshop-setup-job.yaml --apply                  # 최초 1회: 레시피 clone + Isaac Lab 태스크 패키지
./render.sh rl/mujoco-setup-job.yaml --apply                       # 최초 1회: /fsx/envs/mujoco venv
TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply   # MuJoCo SO-101 Reach (CPU) — 메인 경로 (모듈 11 은 NAMESPACE=hyperpod-ns-team-a 로 Kueue 큐 경유)
./render.sh rl/mujoco-render-job.yaml --apply                      # 정책 검증: 성공률 + mp4/gif
MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply   # Isaac Lab SO-101 Reach (GPU 쿼터가 있을 때)
./render.sh rl/isaaclab-play-job.yaml --apply                      # GPU 노드 DCV 데스크톱에 Isaac Sim 재생 (모듈 10 §10.7 방법 B)
./render.sh setup/groot-setup-job.yaml --apply                     # 최초 1회 (VLA): /fsx/envs/gr00t + Isaac-GR00T + SO-101 데이터셋
MAX_STEPS=2000 ./render.sh rl/groot-finetune-job.yaml --apply      # SO-101 로 GR00T 파인튜닝 (GPU, 약 40분)
./render.sh rl/openloop-eval-job.yaml --apply                      # 파인튜닝한 체크포인트를 녹화 궤적과 비교해 채점
MAX_MSE=400 ./render.sh rl/eval-gate-job.yaml --apply              # 그 점수를 PASS/BLOCK 결정으로 — BLOCK 이면 0 이 아닌 값으로 끝난다 (CPU)
```

| 파일 | 역할 |
|---|---|
| `render.sh` | envsubst 렌더 + `--apply`. 변수: `NAMESPACE`(기본 `rl`; `hyperpod-ns-*` 이면 Kueue 라벨 유지, 그 외 라벨 제거) `QUEUE` `PRIORITY`(training-priority) `TASK` `NUM_ENVS` `MAX_ITERATIONS` `TOTAL_STEPS` `CHECKPOINT` `EPISODES` `JOB_SUFFIX` `FSX_*` |
| `fsx-pvc.yaml` | 정적 PV(`fsx-pv-<ns>`) + PVC(`fsx-pvc`). 정적 PV 는 PVC 하나에만 바인딩되므로 네임스페이스마다 한 쌍 |
| `setup/workshop-setup-job.yaml` | `/fsx/scratch/aws-physical-ai-recipes` clone, `/fsx/scratch/isaaclab-workshop/src` 배치 |
| `rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0` + `train_isaaclab.py`, `nvidia.com/gpu: 1`, ml.g5.8xlarge |
| `rl/mujoco-setup-job.yaml` / `rl/mujoco-train-job.yaml` | `/fsx/envs/mujoco` venv(`setup_mujoco_env.sh`) + `train_mujoco.py`, ml.c5.4xlarge, 12 vCPU (노드당 Job 1개) |
| `rl/mujoco-render-job.yaml` | `play_mujoco.py`: 결정적 에피소드 성공률 + OSMesa 렌더 mp4/gif (`CHECKPOINT`, `EPISODES`) |
| `setup/groot-setup-job.yaml` | VLA 경로 최초 1회. `scripts/setup_groot_env.sh` + `scripts/prepare_groot_dataset.sh` 를 돌려 `/fsx/envs/gr00t`, `/fsx/scratch/Isaac-GR00T`(릴리스 태그 고정), `/fsx/datasets/groot/<DATASET>` 를 만든다. GPU, 25~40분, 멱등 |
| `rl/groot-finetune-job.yaml` | `slurm-templates/vla/finetune_groot_venv.sbatch` 의 EKS 대응본. venv·체크아웃·`scripts/patch_groot_repo.py` 를 Slurm 경로와 공유한다. 산출물은 추적이 켜져 있으면 `/fsx/checkpoints/vla/mlflow/<run_id>/artifacts/checkpoint-<step>`, 꺼져 있으면 `/fsx/checkpoints/vla/groot-<DATASET>/checkpoint-<step>` (`MAX_STEPS`, `GLOBAL_BATCH_SIZE`, `GROOT_VERSION`) |
| `rl/openloop-eval-job.yaml` | 체크포인트를 녹화 LeRobot 궤적과 비교해 action MSE 를 내고 MLflow 실험 `vla-eval` 에 기록한다. `CHECKPOINT` 기본값은 `latest` 이고 위 두 레이아웃 모두에서 Job 안에서 해석하므로 두 경로의 산출물 모두 가능 (`CHECKPOINT`, `DATASET_PATH`, `NUM_EPISODES`) |
| `rl/eval-gate-job.yaml` | 평가 산출물을 읽고 BLOCK 이면 0 이 아닌 값으로 끝난다. 이 exit code 가 평가 결과를 구속력 있게 만드는 지점이다 — Argo 의 submit 단계가 failed Job 을 워크플로 실패로 바꾸므로 뒤에 매달린 단계가 실행되지 않는다 (Slurm 의 `--dependency=afterok` 에 대응). CPU 만 쓴다. `GATE_INPUT=openloop` 은 action MSE 로 차단만 할 수 있고, `trials` / `rollout` 은 태스크 성공률이므로 승격할 수 있다 — `PROMOTE_ALIAS` 를 주면 Model Registry alias 를 옮긴다 (`GATE_INPUT`, `GATE_SOURCE`, `MAX_MSE`, `THRESHOLD`, `REQUIRE_DISTINGUISHABLE`, `MAX_SYSTEMATIC_FAILURES`, `PROMOTE_ALIAS`, `MODEL_NAME`) |
| `governance/cluster-policy.json` | priority class training(100) / inference(70) / background(10), FairShare |
| `governance/compute-quota-team-a.json` | team-a: ml.g5.8xlarge 1 + ml.c5.4xlarge 1, LendAndBorrow 100%, 팀 내 LowerPriority 선점 |
| `governance/compute-quota-team-b.json` | team-b: ml.c5.4xlarge 1 |

규칙: task governance 의 admission policy 는 팀 네임스페이스의 **Job 과 Pod 모두**에 `kueue.x-k8s.io/queue-name` 라벨을
요구한다. 모든 템플릿은 Job metadata 와 pod template 양쪽에 `queue-name` / `priority-class` 라벨을 둔다.
