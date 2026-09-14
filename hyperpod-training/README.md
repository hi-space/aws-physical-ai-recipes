# HyperPod Distributed Training Infrastructure — Hands-on Guide

Deploy an AWS SageMaker HyperPod based Physical AI (VLA/RL) distributed training environment and walk through the full pipeline — data preparation, training runs, and MLflow monitoring.

> 한국어 문서: [README.ko.md](README.ko.md)

## Architecture Summary

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ HyperPod Cluster (SLURM Managed)                                              │
│  ├─ head   (ml.m5.xlarge) — controller, always on                             │
│  ├─ gpu-g5-8x (ml.g5.8xlarge) — RL training (from 0, same type as debug)      │
│  │     -c gpuGroups=extended: adds g6e/g6/p4d/p5 groups                       │
│  │     (all start from node count 0)                                          │
│  ├─ cpu-c5-4x / cpu-c5-9x / cpu-m5-4x — MuJoCo RL (CPU, cpu partition, from 0)│
│  └─ debug  (ml.g5.8xlarge)    — debugging/visualization (from 0)              │
├───────────────────────────────────────────────────────────────────────────────┤
│ Storage                                                                       │
│  ├─ FSx for Lustre (1.2TB) ← mounted at /fsx                                  │
│  └─ S3 Data Bucket ↔ FSx auto sync                                            │
├───────────────────────────────────────────────────────────────────────────────┤
│ MLflow Tracking Server (SageMaker Managed)                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- AWS CLI v2 + credentials configured
- Node.js 18+ / npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- Session Manager Plugin ([install guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- Region: `us-east-1` (check GPU quotas before deploying — see below)

---

## Step 1: Set Up the CDK Project

```bash
cd hyperpod-training/infra
npm install
```

CDK Bootstrap (one time only):
```bash
cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

## Step 2: Deploy the Infrastructure

### Basic Deployment

```bash
npx cdk deploy -c region=us-east-1 --require-approval never
```

### Customizing Deployment Parameters

CDK context parameters read by `bin/app.ts`.

| Parameter | Default | Description |
|---------|--------|------|
| `region` | `CDK_DEFAULT_REGION` | Deployment region |
| `createVpc` | true | Create a new VPC (false to use an existing VPC) |
| `vpcCidr` | 10.0.0.0/16 | CIDR of the VPC to create |
| `gpuMaxCount` | 4 | Max node count per GPU instance type group |
| `gpuGroups` | core | GPU group profile. `core` = a single gpu-g5-8x (compatible with the Workshop Studio SageMaker allow list), `extended` = adds g6e/g6/p4d/p5 groups |
| `profile` | personal | Deployment profile. `workshop-studio` = Workshop Studio event account (us-east-1/us-west-2 only). The head node is `ml.m5.xlarge` under both profiles — the measured WS account cluster usage quota was m5.xlarge 10, g5.* 0 |
| `gpuCount` | 0 | Node count to start in the default training group (gpu-g5-8x, ml.g5.8xlarge) (after deployment, prefer `scripts/scale-cluster.sh`) |
| `cpuMaxCount` | 2 | Max node count for each CPU group (cpu-c5-4x / cpu-c5-9x / cpu-m5-4x) |
| `cpuCount` | 0 | Node count to start in the default CPU training group (cpu-c5-4x, ml.c5.4xlarge — MuJoCo RL) |
| `debugCount` | 0 | Node count to start in the debug(DCV) group (0 or 1) |
| `gpuUseSpot` | false | Use Spot instances for the GPU group |
| `fsxCapacityGiB` | 1200 | FSx storage capacity (GiB) |
| `enableMlflow` | false | (optional) Whether to create a managed MLflow experiment tracking server |
| `amiUpdateSchedule` | (off) | AMI security patch schedule. Turn on with `default`(`cron(00 18 ? * 1#2 *)`) or a cron expression. Once on, subsequent `cdk deploy` calls fail because HyperPod refuses modification of ScheduledUpdateConfig, so it is off by default |

Example — small-scale test:
```bash
npx cdk deploy \
  -c region=us-east-1 \
  -c gpuMaxCount=1 \
  -c fsxCapacityGiB=1200 \
  --require-approval never
```

> **Check the GPU quota first.** GPU instance groups are created one per type according to the
> profile (`core`: g5-8x / `extended`: + g6e/g6/p4d/p5) in `lib/config/cluster-config.ts`, and the
> initial node count is always 0. If a type's quota is 0, jobs on it stay `PENDING` forever, so check before deploying.
>
> ```bash
> aws service-quotas list-service-quotas --service-code sagemaker --region us-east-1 \
>   --query "Quotas[?contains(QuotaName,'cluster usage') && Value>\`0\`].[QuotaName,Value]" --output text
> ```

### Verify the Deployment (~20 minutes)

```bash
# Check stack status
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].StackStatus"

# Check outputs
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].Outputs"
```

## Connecting to the Head Node (head-node.sh)

HyperPod nodes sit in a private subnet and their SSM target has the form
`sagemaker-cluster:<CLUSTER_ID>_head-<INSTANCE_ID>`. The script looks both IDs up and opens the
session directly as the `ubuntu` user (`AWS-StartInteractiveCommand` + `sudo -iu ubuntu`), so no
`sudo su - ubuntu` after login:

```bash
./scripts/head-node.sh                  # ubuntu shell on the head node (uses $REGION, hyperpod-<ACCOUNT_ID>)
./scripts/head-node.sh --print-target   # just print the SSM target (for port forwarding etc.)
./scripts/head-node.sh --root           # plain root session
./scripts/head-node.sh --cluster hyperpod-eks-<ACCOUNT_ID> --region us-west-2
```

## Scaling GPU Nodes Up/Down (scale-cluster.sh)

GPU instance groups start at node count 0 right after deployment (zero cost). Scale nodes up
right before training and back down to 0 when done. Use the script that wraps
`aws sagemaker update-cluster`, without redeploying the CDK stack:

```bash
# Bring up 1 GPU node for training (wait until InService, 10-20 min)
./scripts/scale-cluster.sh gpu-g5-8x 1 --wait

# Scale back to 0 after training finishes
./scripts/scale-cluster.sh gpu-g5-8x 0

# DCV debug node (visualization verification)
./scripts/scale-cluster.sh debug 1 --wait

# CPU node for MuJoCo RL (Slurm path, workshop appendix E3)
./scripts/scale-cluster.sh cpu-c5-4x 1 --wait
```

> The script changes node counts outside of CloudFormation, so it creates drift against the CDK stack.
> Running `cdk deploy` again afterward reverts the node count to the context value (0 by default),
> and it has no effect on `cdk destroy`. If you want to manage this consistently through IaC,
> redeploying with `-c gpuCount=1` also works (in that case, be sure to also specify the other
> context values used in the existing deployment).

## MuJoCo (CPU) RL — Train and Verify Without a GPU Node (Workshop Slurm Path S3)

A path for accounts where the `ml.g5.*` cluster quota is 0 (e.g. Workshop Studio event accounts). CPU group
(`cpu-c5-4x`, 16 vCPU) trains the SO-101 Reach task with MuJoCo + Stable-Baselines3(PPO), then
verifies it by producing mp4/gif via offscreen rendering. Observations/actions/rewards are designed to match Isaac Lab Reach.

```bash
# [code-server] bring up the CPU node (5-10 min)
./scripts/scale-cluster.sh cpu-c5-4x 1 --wait

# [head node] one-time: /fsx/envs/mujoco venv + mujoco_menagerie(robotstudio_so101) + task package
bash /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/scripts/setup_mujoco_env.sh

# [head node] train (cpu partition, 1M steps ≈ 5 min) → /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/
sbatch slurm-templates/rl/train_mujoco.sbatch          # TASK / NUM_ENVS / TOTAL_STEPS / CHECKPOINT
slurm-templates/rl/run_mujoco.sh --steps 3000000        # wrapper

# [head node] evaluation + video (model_best.zip → videos/model_best.{mp4,gif}, synced to S3)
sbatch slurm-templates/rl/play_mujoco.sbatch           # CHECKPOINT / EPISODES / MUJOCO_GL
CHECKPOINT=untrained EPISODES=2 sbatch slurm-templates/rl/play_mujoco.sbatch   # pre-training comparison video (videos/untrained.gif)

# [head node] watch the policy live instead: DCV desktop on the CPU node (xfce + Mesa, no GPU), then
# inside it: python examples/rl/play_mujoco.py --viewer --checkpoint <model.zip>
sbatch slurm-templates/debug/dcv_session_cpu.sbatch  # prints the SSM port-forward + viewer commands

# [code-server] scale back to 0 when done
./scripts/scale-cluster.sh cpu-c5-4x 0
```

| File | Role |
|---|---|
| `mujoco-workshop/` | `Workshop-SO101-Reach-MuJoCo-v0` Gymnasium task package (`so101_reach.py`) |
| `scripts/setup_mujoco_env.sh` | Creates the FSx venv, sparse-checks-out the pinned menagerie commit, installs the package, runs the smoke test (executed on the head node) |
| `examples/rl/train_mujoco.py` | SB3 PPO + SubprocVecEnv(1 process per vCPU) + VecNormalize, selects model_best.zip, TensorBoard `reward_terms/` |
| `examples/rl/play_mujoco.py` | Deterministic evaluation (success rate / final distance) + `MUJOCO_GL=egl` offscreen mp4/gif, `--untrained` for a pre-training comparison video, `--viewer` for a live MuJoCo window on the DCV desktop |
| `slurm-templates/rl/train_mujoco.sbatch`, `play_mujoco.sbatch`, `run_mujoco.sh` | `--partition=cpu` Slurm templates |
| `slurm-templates/debug/dcv_session_cpu.sbatch` | DCV session on a CPU node (setup_dcv.sh installs xfce + DCV there too); prints the SSM target and the `--viewer` command |

## EKS Orchestration Path — Observability / Task Governance (Workshop Modules 8-11, main path for the RL track)

Passing `-c orchestrator=eks` to the same CDK app deploys a separate **EKS orchestration HyperPod**
stack `HyperPodEks-<ACCOUNT_ID>` (cluster `hyperpod-eks-<ACCOUNT_ID>`) alongside the Slurm stack. It puts to
actual use the two operational pillars that the Slurm path only introduced.

- **Observability** — the EKS add-on `amazon-sagemaker-hyperpod-observability` plus Amazon Managed Service for
  Prometheus (AMP) and Grafana. CDK creates the AMP workspace, the add-on, and Grafana (default: in-cluster Helm
  install, reading AMP via SigV4), so GPU/node/Kueue dashboards are immediately available. Accounts with an
  IAM Identity Center organization instance can use `-c grafanaMode=amg` to use Amazon Managed Grafana instead.
- **Task governance** — the EKS add-on `amazon-sagemaker-hyperpod-taskgovernance` (Kueue). Once you create a
  cluster policy (priority classes) and per-team compute quotas via CLI, team namespaces and LocalQueues are
  created automatically, and Jobs pass through the queue to run, wait, or get preempted according to quota and priority.

```
┌───────────────────────────────────────────────────────────────────────┐
│ EKS control plane (hyperpod-eks-<ACCOUNT_ID>, K8s 1.34)               │
│   HyperPodHelmChart: HMA, deep health check, nvidia/EFA plugin,       │
│   Kubeflow training/MPI operator                                      │
│   Add-ons: pod-identity-agent, aws-fsx-csi-driver,                    │
│           hyperpod-observability, hyperpod-taskgovernance(Kueue)      │
├───────────────────────────────────────────────────────────────────────┤
│ HyperPod instance groups (NodeProvisioningMode: Continuous)           │
│  ├─ cpu-c5-4x  (ml.c5.4xlarge) ×1 always on — add-on pods + MuJoCo CPU│
│  └─ gpu-g5-8x  (ml.g5.8xlarge) ×0 — Isaac Lab RL (scale-cluster.sh)   │
├───────────────────────────────────────────────────────────────────────┤
│ FSx for Lustre (/fsx, static PV via CSI) ↔ S3 hyperpod-eks-data-…     │
│ AMP workspace → Grafana (in-cluster, port-forward | AMG option)       │
└───────────────────────────────────────────────────────────────────────┘
```

Both profiles can be deployed. `profile=workshop-studio` (event account) has a GPU cluster quota of 0, so it leaves the GPU group at 0 and
trains/verifies through the MuJoCo CPU path (module 9) on the single always-on system node cpu-c5-4x (ml.c5.4xlarge), then scales it to 2 in module 11 for the governance/observability exercises. At events, the provisioner
template (`physical-ai-on-aws/static/e2e-workshop-provisioner.yaml`)'s `DeployHyperPodEks=true` pre-deploys this stack.

### Deploy

```bash
cd hyperpod-training/infra
npm install
npx cdk deploy -c orchestrator=eks -c region=${REGION} --require-approval never   # ~35 min
```

| Parameter | Default | Description |
|---------|--------|------|
| `orchestrator` | `slurm` | Set to `eks` |
| `eksVersion` | `1.34` | Kubernetes version. The task governance add-on's Kueue 0.19 requires `resource.k8s.io/v1` (1.34+) |
| `eksAdminArns` | (deployer) | Comma-separated IAM principal ARNs to grant additional cluster admin access entries. The deployer is auto-included via `aws sts get-caller-identity` |
| `systemNodeCount` | 1 | Number of always-on system nodes (cpu-c5-4x). Add-ons only install once at least one node (4xlarge or larger) exists |
| `enableObservability` | true | AMP + Grafana + observability add-on |
| `grafanaMode` | `self-hosted` | `self-hosted` = in-cluster Grafana (Helm, `kubectl port-forward`, subpath `/absproxy/3000/` = the code-server absproxy path), `amg` = Amazon Managed Grafana (requires an IAM Identity Center **organization** instance — account instances fail with "SSO is not enabled"), `none` |
| `enableTaskGovernance` | true | task governance add-on |
| `deepHealthChecks` | false | `OnStartDeepHealthChecks` for the GPU group (InstanceStress, InstanceConnectivity). Turning it on lengthens node startup |
| `gpuGroups`, `gpuMaxCount`, `gpuCount`, `gpuUseSpot`, `fsxCapacityGiB`, `vpcCidr` | Same as Slurm | |

Key outputs: `KubeconfigCommand`, `ClusterName`, `ClusterArn`, `AmpWorkspaceId`, `GrafanaAccess`(self-hosted) or
`GrafanaUrl`/`GrafanaWorkspaceId`(amg), `S3BucketName`, `FsxFileSystemId`/`FsxDnsName`/`FsxMountName`.

### After Deployment

```bash
cd hyperpod-training
./scripts/eks/kubeconfig.sh                       # sets kubectl context to hyperpod-eks + checks nodes/add-ons
kubectl port-forward -n grafana svc/grafana 3000:80 &   # Grafana → https://<CodeServerUrl>/absproxy/3000/ or http://localhost:3000/absproxy/3000/ (admin / the admin-password in the grafana Secret)
kubectl get secret -n grafana grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
# For grafanaMode=amg: ./scripts/eks/grafana-user.sh <IdC-username>  → log in with the GrafanaUrl output
```

### Submitting Jobs (k8s-templates)

Module 9 (train / verify): plain namespace `rl`, scheduled straight onto the always-on system node without Kueue

```bash
cd hyperpod-training/k8s-templates
./render.sh fsx-pvc.yaml --apply                                   # creates the rl namespace + /fsx PV+PVC
./render.sh setup/workshop-setup-job.yaml --apply                  # one-time: recipe + task package to /fsx
./render.sh rl/mujoco-setup-job.yaml --apply                       # one-time: /fsx/envs/mujoco venv (~4 min)
TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply   # MuJoCo SO-101 Reach (CPU 12 vCPU, ~5 min)
kubectl get jobs,pods -n rl
kubectl logs -n rl -l app=mujoco-rl -f
./render.sh rl/mujoco-render-job.yaml --apply                      # policy verification: success rate + mp4/gif (OSMesa, ~5 min)

# For accounts with a GPU quota (module 10): Isaac Lab
../scripts/scale-cluster.sh gpu-g5-8x 1 --wait --cluster hyperpod-eks-<ACCOUNT_ID>
MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply   # Isaac Lab SO-101 Reach (GPU)
```

Module 11 (task governance / observability): team namespaces `hyperpod-ns-team-a/b`, submitted through the Kueue queue

```bash
../scripts/eks/create-governance.sh                                # cluster policy + team-a / team-b compute quota
../scripts/scale-cluster.sh cpu-c5-4x 2 --wait --cluster hyperpod-eks-<ACCOUNT_ID>   # add 1 more CPU node so both teams' Jobs overlap (~3 min)
export NAMESPACE=hyperpod-ns-team-a
./render.sh fsx-pvc.yaml --apply                                   # /fsx PV+PVC in the team-a namespace
NAMESPACE=hyperpod-ns-team-b ./render.sh fsx-pvc.yaml --apply     # team-b
LOG_DIR=/fsx/scratch/governance-demo/team-a PRIORITY=background-priority ./render.sh rl/mujoco-train-job.yaml --apply   # the Kueue labels get filled in
kubectl get workloads -A
```

| File | Role |
|---|---|
| `k8s-templates/render.sh` | Substitutes `${NAMESPACE}` `${QUEUE}` `${PRIORITY}` `${TASK}` and others + `--apply`. Default namespace `rl` (created if absent); given `hyperpod-ns-*` it fills in the Kueue labels, otherwise it strips the label lines |
| `k8s-templates/fsx-pvc.yaml` | FSx PV+PVC for a namespace (a static PV binds to only one PVC, so each namespace needs its own pair) |
| `k8s-templates/setup/workshop-setup-job.yaml` | Clones the recipe + places the Isaac Lab task package (corresponds to Slurm appendix E2 §S2.3) |
| `k8s-templates/rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0`, `nvidia.com/gpu: 1`, Kueue labels (corresponds to finetune_isaaclab.sbatch) |
| `k8s-templates/rl/mujoco-setup-job.yaml`, `mujoco-train-job.yaml`, `mujoco-render-job.yaml` | `/fsx/envs/mujoco` venv + SB3 PPO on ml.c5.4xlarge (corresponds to train_mujoco.sbatch), policy verification video (corresponds to play_mujoco.sbatch) |
| `k8s-templates/governance/*.json` | Inputs for cluster policy, team-a/team-b compute quota |
| `scripts/eks/kubeconfig.sh` · `grafana-user.sh` · `create-governance.sh` · `delete-governance.sh` | Access · Grafana(AMG) user · policy create/delete |
| `eks/grafana-dashboards/hyperpod-task-governance.json` | Dashboards for Kueue waiting/running/preemption, ClusterQueue allocation/borrowing, DCGM GPU utilization (provisioned into self-hosted Grafana) |
| `lifecycle-scripts/on_create_eks.sh` | EKS node lifecycle. CPU nodes: diagnostic logging only (kubelet/plugins are handled by HyperPod/Helm). GPU nodes additionally run `setup_nvidia_driver.sh` (580 driver for Isaac Sim rendering) and `setup_dcv_al2023.sh` (AL2023 GNOME + DCV, session `workspace`, ec2-user/hyperpod) for workshop module 10 §10.7 method B |
| `lifecycle-scripts/setup_dcv_al2023.sh` | DCV install for Amazon Linux 2023 (the EKS AMI). Counterpart of the Slurm AMI's Ubuntu `setup_dcv.sh`; installs no Docker |
| `k8s-templates/rl/isaaclab-play-job.yaml` | Replay Job that opens the Isaac Sim window on the GPU node's DCV session (hostPath `/tmp/.X11-unix`, `X_DISPLAY` auto-selected) |
| `scripts/eks/dcv-target.sh` | Prints the GPU node's SSM target and the DCV port-forwarding command |
| `eks/helm/HyperPodHelmChart` | Vendored HyperPod Helm dependency (`VENDOR.md`) |

### Cleanup

```bash
./scripts/eks/delete-governance.sh                                   # compute quota → cluster policy (leaving these blocks cluster deletion)
./scripts/scale-cluster.sh gpu-g5-8x 0 --cluster hyperpod-eks-<ACCOUNT_ID>
aws s3 rm s3://hyperpod-eks-data-<ACCOUNT_ID>-<REGION> --recursive
cd infra && npx cdk destroy -c orchestrator=eks -c region=${REGION} --force   # ~25 min
```

## Step 3: Check the Cluster Status

```bash
CLUSTER_NAME="hyperpod-<ACCOUNT_ID>"

# Cluster status
aws sagemaker describe-cluster \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1 \
  --query "{Status:ClusterStatus,Groups:InstanceGroups[*].{Name:InstanceGroupName,Count:CurrentCount,Status:Status}}"

# Node list
aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1
```

Expected result:
```json
{
  "Status": "InService",
  "Groups": [
    { "Name": "head",        "Count": 1, "Status": "InService" },
    { "Name": "gpu-g5-8x",  "Count": 0, "Status": "InService" },
    { "Name": "debug",       "Count": 0, "Status": "InService" }
  ]
}
```

## AMI Security Patching (Scheduled Update)

The HyperPod AMI includes the kernel, NVIDIA drivers, OpenSSL, and more, and AWS periodically releases patched AMIs. Without patching, nodes remain on whichever AMI was current when they were created.

**The scheduled patch is off by default.** Deploying with `-c amiUpdateSchedule=default` applies `DEFAULT_AMI_UPDATE_SCHEDULE` (`lib/config/cluster-config.ts`, the second Sunday of every month at 18:00 UTC) to the `ScheduledUpdateConfig` of every instance group. However, because HyperPod refuses to modify a `ScheduledUpdateConfig` once set, a stack with the schedule turned on will fail subsequent `cdk deploy` calls (node count/group changes). For a cluster that keeps getting updated, like in the workshop, leave it off and use manual patching as shown below.

```bash
# Check the schedule
aws sagemaker describe-cluster --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "InstanceGroups[].{Name:InstanceGroupName,Schedule:ScheduledUpdateConfig.ScheduleExpression}"

# Check the last patch time (if it equals LaunchTime, it has never been patched)
aws sagemaker list-cluster-nodes --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "ClusterNodeSummaries[].{Group:InstanceGroupName,Launch:LaunchTime,LastPatch:LastSoftwareUpdateTime}"

# Patch immediately without waiting for the scheduled time (check the prerequisites below first)
aws sagemaker update-cluster-software --cluster-name ${CLUSTER_NAME} --region us-east-1
```

To turn on the schedule use `-c amiUpdateSchedule=default`; to set a custom cadence use `-c amiUpdateSchedule='cron(00 18 1 * ? *)'`.

### Check These Before Patching

1. **The lifecycle bucket must still exist.** Patching replaces the root volume with the new AMI and then re-runs `on_create.sh` from `LifeCycleConfig.SourceS3Uri`. If the bucket is missing, the patch fails and the cluster drops to `Failed`.
   ```bash
   aws s3 ls s3://hyperpod-lifecycle-<account>-<region>/lifecycle-scripts/
   ```
2. **The root volume gets reset.** `/fsx` (FSx Lustre) is preserved, but root-volume data such as `/home/ubuntu` and the Slurm accounting DB (mariadb) is lost. If needed, back it up to S3 with AWS's [`patching-backup.sh`](https://github.com/aws-samples/awsome-distributed-training/blob/main/1.architectures/5.sagemaker-hyperpod/patching-backup.sh).
   ```bash
   sudo bash patching-backup.sh --create s3://<backup-bucket-path>   # before patching
   sudo bash patching-backup.sh --restore s3://<backup-bucket-path>  # after patching
   ```
3. **No jobs should be running.** In a Slurm cluster, instance groups are replaced all at once, so any in-progress job is interrupted (check with `squeue`).

### Slurm Cluster Limitations

| Feature | Slurm | Notes |
|---|---|---|
| `ScheduledUpdateConfig` (cron schedule) | ✅ | Optional(`-c amiUpdateSchedule`); off by default |
| `AutoPatchConfig` (auto-patch idle nodes without workload disruption) | ❌ | **EKS only** |
| `DeploymentConfig` (batched rolling replacement + CloudWatch auto rollback) | ❌ | **EKS only** |
| Update AMI from the console | ❌ | **EKS only**, API/CLI only |

In other words, Slurm cannot patch around a workload, so it's important to schedule the patch time for a window without training.
References: [AMI update docs](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-release-ami-update.html) · [auto-patching docs](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-ami-auto-patching.html)

## Step 4: Connect to the Head Node (SSH via Jump Host)

The CDK deployment creates a Jump Host in a Public Subnet. Use it to SSH into the Head Node.

### 4.1 Download the SSH Key

Run the CDK output's `JumpKeyCommand` to download the Jump Host's SSH key.

```bash
# Download the Jump Host SSH key
aws ssm get-parameter \
  --name /ec2/keypair/<KEY_PAIR_ID> \
  --with-decryption \
  --query Parameter.Value \
  --output text \
  --region us-east-1 > ~/.ssh/hyperpod-jump.pem

chmod 600 ~/.ssh/hyperpod-jump.pem
```

> `<KEY_PAIR_ID>` can be found in the CDK output's `JumpKeyCommand`.

### 4.2 Connect to the Jump Host

```bash
JUMP_IP="<JumpHostIp from the CDK output>"

ssh -i ~/.ssh/hyperpod-jump.pem ec2-user@${JUMP_IP}
```

### 4.3 Connect to the Head Node

The Jump Host already has the key for connecting to the Head Node (`~/.ssh/cluster_access_key`) auto-deployed.

```bash
# Run on the Jump Host
HEAD_IP="<head node private IP>"  # check with describe-cluster-node

ssh -i ~/.ssh/cluster_access_key ubuntu@${HEAD_IP}
```

Or connect in one step from your local machine with ProxyJump:
```bash
ssh -i ~/.ssh/hyperpod-jump.pem -o ProxyCommand="ssh -i ~/.ssh/hyperpod-jump.pem -W %h:%p ec2-user@${JUMP_IP}" \
  -i <(aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key -) \
  ubuntu@${HEAD_IP}
```

### 4.4 Set Up SSH Config (Recommended)

Adding the following to `~/.ssh/config` lets you connect directly with `ssh hyperpod`:

```
Host hyperpod-jump
    HostName <JUMP_IP>
    User ec2-user
    IdentityFile ~/.ssh/hyperpod-jump.pem

Host hyperpod
    HostName <HEAD_NODE_PRIVATE_IP>
    User ubuntu
    IdentityFile ~/.ssh/cluster_access_key
    ProxyJump hyperpod-jump
```

> Copy `cluster_access_key` from the Jump Host's `~/.ssh/cluster_access_key` to your local machine, or download it from S3:
> ```bash
> aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key ~/.ssh/cluster_access_key
> chmod 600 ~/.ssh/cluster_access_key
> ```

### 4.5 Verify After Connecting

```bash
sinfo                  # SLURM partition status
df -h /fsx             # check the FSx mount
ls /fsx/               # datasets, checkpoints, scratch directories
```

## Step 5: Upload the Dataset (S3 → FSx Auto Sync)

When you upload data to S3, it auto-syncs to FSx `/fsx/datasets/`.

```bash
# Upload data from your local machine to S3
BUCKET="hyperpod-data-<ACCOUNT_ID>-us-east-1"

aws s3 cp ./my-dataset/ s3://${BUCKET}/datasets/groot/my-robot/ --recursive

# Check on the head node after a few minutes
ls /fsx/datasets/groot/my-robot/
```

### LeRobot v2 Format Dataset Structure

```
/fsx/datasets/groot/aloha/
├── meta/
│   ├── info.json
│   ├── episodes.jsonl
│   └── tasks.jsonl
├── data/
│   ├── chunk-000/
│   │   └── episode_000000.parquet
│   └── ...
└── videos/
    ├── chunk-000/
    │   └── observation.images.top/
    │       └── episode_000000.mp4
    └── ...
```

## Step 6: Run VLA Training (GR00T Fine-tuning)

### Submitting a SLURM Job

```bash
# run on the head node
cd /fsx/scratch

# copy the training script (auto-synced from S3, or copy it directly)
cp /path/to/examples/vla/train_groot.py .

# submit via the SLURM template
/path/to/slurm-templates/vla/run_vla.sh \
  --model groot \
  --dataset /fsx/datasets/groot/aloha \
  --epochs 50 \
  --nodes 1
```

### Submitting sbatch Directly

```bash
sbatch --partition=dev --gres=gpu:4 --nodes=1 <<'EOF'
#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --output=/fsx/scratch/logs/groot-%j.out

srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_groot.py \
       --dataset-path /fsx/datasets/groot/aloha \
       --modality-config aloha \
       --output-dir /fsx/checkpoints/vla/groot-aloha \
       --max-steps 5000
EOF
```

### Monitoring the Job

```bash
squeue                              # check the job queue
squeue -j <JOB_ID>                  # check a specific job's status
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out  # follow the log in real time
scancel <JOB_ID>                    # cancel a job
```

## Step 7: Run RL Training (IsaacLab + Ray)

Simulation and training run concurrently in an Actor-Learner pattern.

```bash
# run on the head node
/path/to/slurm-templates/rl/run_rl.sh \
  --env Isaac-Cartpole-v0 \
  --num-actors 8

# example output:
# === RL Training: Isaac-Cartpole-v0 ===
#   Actors: 8
#   Learner job: 123
#   Actor jobs: 124 (array 0-7)
```

## Step 8: Track Experiments with MLflow

### MLflow Setup

```bash
# install the MLflow client on the head node
pip install mlflow sagemaker-mlflow boto3

# set the tracking URI (use the CDK output)
export MLFLOW_TRACKING_URI="https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow"
```

### Accessing the MLflow UI

Access the SageMaker Managed MLflow UI via the `MLflowTrackingUri` output from the CDK deployment:
```
https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow
```

### Using MLflow from Training Code

```python
import mlflow

mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
mlflow.set_experiment("groot-finetune")

with mlflow.start_run():
    mlflow.log_params({"lr": 2e-5, "batch_size": 32})
    # ... training loop ...
    mlflow.log_metrics({"loss": 0.01, "accuracy": 0.95}, step=1000)
```

## Step 9: Check Checkpoints (FSx → S3 Auto Export)

Once training results are saved to `/fsx/checkpoints/`, they auto-export to S3.

```bash
# check on FSx
ls /fsx/checkpoints/vla/groot-aloha/

# check on S3 (synced after a few minutes)
aws s3 ls s3://${BUCKET}/checkpoints/vla/groot-aloha/
```

## Step 10: Clean Up Resources

CloudFormation only deletes empty buckets. At destroy time, the two buckets are not empty (the lifecycle bucket holds the scripts the stack uploaded plus `config/head_ip.txt` recorded by the cluster; the data bucket holds checkpoints/datasets synced from FSx), so **empty them first, then destroy.**

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

# 1) Empty both S3 buckets (required)
aws s3 rm s3://hyperpod-data-${ACCOUNT_ID}-${REGION} --recursive --region ${REGION}
aws s3 rm s3://hyperpod-lifecycle-${ACCOUNT_ID}-${REGION} --recursive --region ${REGION}

# 2) Delete the stack (cluster + FSx + Jump Host + VPC, ~20 min)
cd hyperpod-training/infra
npx cdk destroy -c region=${REGION} --force
```

If the stack ends up `DELETE_FAILED` ("The bucket you tried to delete is not empty") — either step 1 was skipped, or the data bucket's versioning left old versions/delete markers behind — delete every version in the failed bucket and retry the deletion. At this point the cluster, FSx, NAT GW, and Jump Host have already been deleted.

```bash
aws cloudformation describe-stack-events --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION} \
  --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,PhysicalResourceId]" --output table

BUCKET=hyperpod-data-${ACCOUNT_ID}-${REGION}   # or hyperpod-lifecycle-${ACCOUNT_ID}-${REGION}
aws s3api list-object-versions --bucket $BUCKET --region ${REGION} \
  --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }' \
  --output json > /tmp/versions.json
aws s3api delete-objects --bucket $BUCKET --region ${REGION} --delete file:///tmp/versions.json

aws cloudformation delete-stack --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION}
aws cloudformation wait stack-delete-complete --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION}
```

The procedure for workshop participants is the same as content module 12 §12.7B.

---

## Troubleshooting

### Deployment failure: "Unable to retrieve subnets"
- The Execution Role needs EC2 VPC permissions → already included in the CDK

### Deployment failure: "InstanceGroups must have a SlurmConfig with Controller node type"
- The head group needs `SlurmConfig: { NodeType: Controller }` → already included in the CDK

### Can't connect via SSM
- Connect from the AWS Console instead (SageMaker > HyperPod > Clusters > Connect)
- CLI access requires the session-manager-plugin to be installed

### FSx mount not working
- The lifecycle script's FSX_DNS_NAME/FSX_MOUNT_NAME must be set
- After cluster creation, the FSx info must be set in the lifecycle script

### MLflow "already exists" error
- An MLflow server from a previous deployment is still around
- Run `aws sagemaker delete-mlflow-tracking-server --tracking-server-name <name>` then redeploy

### Patch failure: "The lifecycle configuration bucket ... was not found or does not exist"
- Happens when `update-cluster-software` is called after the lifecycle script bucket was deleted
- The cluster drops from `SystemUpdating` → `RollingBack` → `Failed` (nodes are stopped before replacement, so data is preserved)
- Recovery: recreate the bucket with the same name, upload the scripts, then retry the patch
  ```bash
  B=hyperpod-lifecycle-<account>-us-east-1
  aws s3api create-bucket --bucket $B --region us-east-1 \
    --create-bucket-configuration LocationConstraint=us-east-1
  aws s3 cp lifecycle-scripts/ s3://$B/lifecycle-scripts/ --recursive --exclude "*" --include "*.sh"
  printf '%s' "$B" | aws s3 cp - s3://$B/lifecycle-scripts/bucket.conf
  aws sagemaker update-cluster-software --cluster-name <cluster> --region us-east-1
  ```
- Prevention: enable deletion protection on the bucket, or add a bucket-existence check as a pre-patch item

### S3 bucket deletion failure
- A bucket cannot be deleted while it still has objects
- Run `aws s3 rm s3://<bucket-name> --recursive` then retry the stack deletion

---

## Cost Reference

| Component | Hourly Cost | Notes |
|---------|------------|------|
| Head Node (ml.m5.xlarge) | ~$0.20 | Always on |
| Train (gpu-g5-8x, ml.g5.8xlarge) | ~$3.00 | Only while training |
| Debug (ml.g5.8xlarge) | ~$3.00 | Only during visual verification |
| FSx (1.2TB) | ~$0.55 | Always on |
| MLflow | ~$0.10 | Always on |
| **During the hands-on (head only)** | **~$0.85/hr** | |
| **While training runs** | **~$8-10/hr** | |

Be sure to run `cdk destroy` to clean up after the hands-on session.

---

## Next Steps

- [Detailed architecture doc](./docs/architecture.md)
- [Researcher guide](./docs/researcher_guide.md)
- [VLA training examples](./examples/vla/)
- [RL training examples](./examples/rl/)
- [SLURM templates](./slurm-templates/)
