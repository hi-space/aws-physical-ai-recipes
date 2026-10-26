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
./render.sh setup/groot-setup-job.yaml --apply                     # one-time (VLA): /fsx/envs/gr00t + Isaac-GR00T + SO-101 dataset
MAX_STEPS=2000 ./render.sh rl/groot-finetune-job.yaml --apply      # GR00T fine-tune on SO-101 (GPU, ~40 min)
./render.sh rl/openloop-eval-job.yaml --apply                      # score the fine-tuned checkpoint against recorded trajectories
MAX_MSE=400 ./render.sh rl/eval-gate-job.yaml --apply              # turn that score into PASS/BLOCK — exits non-zero on BLOCK (CPU)
```

| File | Role |
|---|---|
| `render.sh` | envsubst rendering + `--apply`. Variables: `NAMESPACE`(defaults to `rl`; keeps the Kueue labels when it is `hyperpod-ns-*`, strips them otherwise) `QUEUE` `PRIORITY`(training-priority) `TASK` `NUM_ENVS` `MAX_ITERATIONS` `TOTAL_STEPS` `CHECKPOINT` `EPISODES` `JOB_SUFFIX` `FSX_*` |
| `fsx-pvc.yaml` | Static PV(`fsx-pv-<ns>`) + PVC(`fsx-pvc`). A static PV binds to only one PVC, so each namespace needs its own pair |
| `setup/workshop-setup-job.yaml` | Clones `/fsx/scratch/aws-physical-ai-recipes`, places `/fsx/scratch/isaaclab-workshop/src` |
| `rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0` + `train_isaaclab.py`, `nvidia.com/gpu: 1`, ml.g5.8xlarge |
| `rl/mujoco-setup-job.yaml` / `rl/mujoco-train-job.yaml` | `/fsx/envs/mujoco` venv(`setup_mujoco_env.sh`) + `train_mujoco.py`, ml.c5.4xlarge, 12 vCPU (one Job per node) |
| `rl/mujoco-render-job.yaml` | `play_mujoco.py`: deterministic episode success rate + OSMesa render mp4/gif (`CHECKPOINT`, `EPISODES`) |
| `setup/groot-setup-job.yaml` | One-time VLA prep: runs `scripts/setup_groot_env.sh` + `scripts/prepare_groot_dataset.sh`, producing `/fsx/envs/gr00t`, `/fsx/scratch/Isaac-GR00T` (pinned release tag), and `/fsx/datasets/groot/<DATASET>`. GPU, 25-40 min, idempotent |
| `rl/groot-finetune-job.yaml` | EKS counterpart of `slurm-templates/vla/finetune_groot_venv.sbatch`. Shares the venv, the checkout, and `scripts/patch_groot_repo.py` with the Slurm path. Writes `/fsx/checkpoints/vla/mlflow/<run_id>/artifacts/checkpoint-<step>` with tracking on, `/fsx/checkpoints/vla/groot-<DATASET>/checkpoint-<step>` with it off (`MAX_STEPS`, `GLOBAL_BATCH_SIZE`, `GROOT_VERSION`) |
| `rl/openloop-eval-job.yaml` | Scores a checkpoint against recorded LeRobot trajectories (action MSE) and logs to MLflow experiment `vla-eval`. `CHECKPOINT` defaults to `latest`, resolved inside the job against both layouts above, so either orchestration path's output works (`CHECKPOINT`, `DATASET_PATH`, `NUM_EPISODES`) |
| `rl/eval-gate-job.yaml` | Reads an eval artifact and exits non-zero on BLOCK, which is what makes the result load-bearing — Argo's submit step turns the failed Job into a failed workflow, holding back anything chained behind it (the EKS equivalent of Slurm `--dependency=afterok`). CPU only. `GATE_INPUT=openloop` gates on action MSE and can only block; `trials` / `rollout` gate on task success rate and can promote, moving a Model Registry alias when `PROMOTE_ALIAS` is set (`GATE_INPUT`, `GATE_SOURCE`, `MAX_MSE`, `THRESHOLD`, `REQUIRE_DISTINGUISHABLE`, `MAX_SYSTEMATIC_FAILURES`, `PROMOTE_ALIAS`, `MODEL_NAME`) |
| `governance/cluster-policy.json` | priority classes training(100) / inference(70) / background(10), FairShare |
| `governance/compute-quota-team-a.json` | team-a: ml.g5.8xlarge 1 + ml.c5.4xlarge 1, LendAndBorrow 100%, LowerPriority preemption within the team |
| `governance/compute-quota-team-b.json` | team-b: ml.c5.4xlarge 1 |

Rule: task governance's admission policy requires the `kueue.x-k8s.io/queue-name` label on **both the
Job and the Pod** in the team namespace. Every template carries the `queue-name` / `priority-class` labels on both the Job metadata and the pod template.
