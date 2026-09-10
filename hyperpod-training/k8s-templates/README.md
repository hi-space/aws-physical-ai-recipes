# k8s-templates: HyperPod EKS Job 템플릿 (워크숍 모듈 9~10)

Slurm 경로의 `slurm-templates/` 에 대응한다. `render.sh` 가 `${VAR}` 를 채워 `kubectl apply` 한다.

```bash
./render.sh fsx-pvc.yaml --apply                                   # 팀 네임스페이스에 /fsx PV+PVC (FSx 정보는 스택 Output)
./render.sh setup/workshop-setup-job.yaml --apply                  # 최초 1회: 레시피 clone + Isaac Lab 태스크 패키지
./render.sh rl/mujoco-setup-job.yaml --apply                       # 최초 1회: /fsx/envs/mujoco venv
TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply   # MuJoCo SO-101 Reach (CPU, Kueue 큐) — 메인 경로
./render.sh rl/mujoco-render-job.yaml --apply                      # 정책 검증: 성공률 + mp4/gif
MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply   # Isaac Lab SO-101 Reach (GPU 쿼터가 있을 때)
```

| 파일 | 역할 |
|---|---|
| `render.sh` | envsubst 렌더 + `--apply`. 변수: `NAMESPACE`(hyperpod-ns-team-a) `QUEUE` `PRIORITY`(training-priority) `TASK` `NUM_ENVS` `MAX_ITERATIONS` `TOTAL_STEPS` `CHECKPOINT` `EPISODES` `JOB_SUFFIX` `FSX_*` |
| `fsx-pvc.yaml` | 정적 PV(`fsx-pv-<ns>`) + PVC(`fsx-pvc`). 정적 PV 는 PVC 하나에만 바인딩되므로 네임스페이스마다 한 쌍 |
| `setup/workshop-setup-job.yaml` | `/fsx/scratch/aws-physical-ai-recipes` clone, `/fsx/scratch/isaaclab-workshop/src` 배치 |
| `rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0` + `train_isaaclab.py`, `nvidia.com/gpu: 1`, ml.g5.8xlarge |
| `rl/mujoco-setup-job.yaml` / `rl/mujoco-train-job.yaml` | `/fsx/envs/mujoco` venv(`setup_mujoco_env.sh`) + `train_mujoco.py`, ml.c5.4xlarge, 12 vCPU (노드당 Job 1개) |
| `rl/mujoco-render-job.yaml` | `play_mujoco.py`: 결정적 에피소드 성공률 + OSMesa 렌더 mp4/gif (`CHECKPOINT`, `EPISODES`) |
| `governance/cluster-policy.json` | priority class training(100) / inference(70) / background(10), FairShare |
| `governance/compute-quota-team-a.json` | team-a: ml.g5.8xlarge 1 + ml.c5.4xlarge 1, LendAndBorrow 100%, 팀 내 LowerPriority 선점 |
| `governance/compute-quota-team-b.json` | team-b: ml.c5.4xlarge 1 |

규칙: task governance 의 admission policy 는 팀 네임스페이스의 **Job 과 Pod 모두**에 `kueue.x-k8s.io/queue-name` 라벨을
요구한다. 모든 템플릿은 Job metadata 와 pod template 양쪽에 `queue-name` / `priority-class` 라벨을 둔다.
