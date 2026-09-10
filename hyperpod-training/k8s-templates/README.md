# k8s-templates: HyperPod EKS Job Templates (Workshop Modules 9-11)

> 한국어 문서: [README.ko.md](README.ko.md)

Counterpart to `slurm-templates/` on the Slurm path. `render.sh` fills in `${VAR}` and runs `kubectl apply`.

```bash
./render.sh fsx-pvc.yaml --apply                                   # /fsx PV+PVC in the rl namespace (FSx info from the stack Output)
./render.sh setup/workshop-setup-job.yaml --apply                  # one-time: clone the recipe + place the Isaac Lab task package
./render.sh rl/mujoco-setup-job.yaml --apply                       # one-time: /fsx/envs/mujoco venv
TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply   # MuJoCo SO-101 Reach (CPU) — main path (module 11 adds NAMESPACE=hyperpod-ns-team-a for the Kueue queue)
./render.sh rl/mujoco-render-job.yaml --apply                      # policy verification: success rate + mp4/gif
MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply   # Isaac Lab SO-101 Reach (when a GPU quota is available)
./render.sh rl/isaaclab-play-job.yaml --apply                      # Isaac Sim replay on the GPU node's DCV desktop (module 10 §10.7 method B)
```

| File | Role |
|---|---|
| `render.sh` | envsubst rendering + `--apply`. Variables: `NAMESPACE`(defaults to `rl`; keeps the Kueue labels when it is `hyperpod-ns-*`, strips them otherwise) `QUEUE` `PRIORITY`(training-priority) `TASK` `NUM_ENVS` `MAX_ITERATIONS` `TOTAL_STEPS` `CHECKPOINT` `EPISODES` `JOB_SUFFIX` `FSX_*` |
| `fsx-pvc.yaml` | Static PV(`fsx-pv-<ns>`) + PVC(`fsx-pvc`). A static PV binds to only one PVC, so each namespace needs its own pair |
| `setup/workshop-setup-job.yaml` | Clones `/fsx/scratch/aws-physical-ai-recipes`, places `/fsx/scratch/isaaclab-workshop/src` |
| `rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0` + `train_isaaclab.py`, `nvidia.com/gpu: 1`, ml.g5.8xlarge |
| `rl/mujoco-setup-job.yaml` / `rl/mujoco-train-job.yaml` | `/fsx/envs/mujoco` venv(`setup_mujoco_env.sh`) + `train_mujoco.py`, ml.c5.4xlarge, 12 vCPU (one Job per node) |
| `rl/mujoco-render-job.yaml` | `play_mujoco.py`: deterministic episode success rate + OSMesa render mp4/gif (`CHECKPOINT`, `EPISODES`) |
| `governance/cluster-policy.json` | priority classes training(100) / inference(70) / background(10), FairShare |
| `governance/compute-quota-team-a.json` | team-a: ml.g5.8xlarge 1 + ml.c5.4xlarge 1, LendAndBorrow 100%, LowerPriority preemption within the team |
| `governance/compute-quota-team-b.json` | team-b: ml.c5.4xlarge 1 |

Rule: task governance's admission policy requires the `kueue.x-k8s.io/queue-name` label on **both the
Job and the Pod** in the team namespace. Every template carries the `queue-name` / `priority-class` labels on both the Job metadata and the pod template.
