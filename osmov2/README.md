# AWS NVIDIA Robotics Reference Architecture

AWS reference implementation for deploying NVIDIA OSMO and validated robotics workflows on Amazon EKS.

This repo owns the AWS side of the stack: a secure EKS landing zone, GPU capacity management, AWS managed backing services, OSMO deployment wrappers, workflow examples, validation artifacts, and compatibility notes. NVIDIA OSMO remains an external pinned dependency; this repo intentionally does not vendor NVIDIA OSMO source, NVIDIA Terraform, or local OSMO patches.

## What This Provides

### AWS Infrastructure

- Current standard-support Amazon EKS baseline on private subnets.
- AWS-native backing services for OSMO: Amazon RDS PostgreSQL, Amazon ElastiCache for Redis, Amazon S3, Amazon ECR, AWS KMS, and IRSA.
- Karpenter GPU NodePool for On-Demand G7e instances with private subnet placement, IMDSv2, encrypted gp3 root volumes, and a pinned EKS AL2023 NVIDIA AMI.
- NVIDIA GPU Operator installed from a pinned Helm chart with driver/toolkit installation disabled for the EKS NVIDIA AMI.
- AWS EFA device plugin installed from a pinned Helm chart with the G7e GPU taint toleration required to expose `vpc.amazonaws.com/efa` on EFA-capable GPU nodes.

### OSMO Deployment

- KAI Scheduler installed from a pinned OCI Helm chart so OSMO workflows use the real `scheduling.run.ai` PodGroup CRDs and `kai-scheduler`.
- Deployment scripts that install OSMO with explicit Helm values instead of invoking upstream `deploy-k8s.sh`.
- OSMO Web UI installed as a private ClusterIP service for local `kubectl port-forward` access.
- CPU and GPU smoke paths to prove the cluster, OSMO service, backend operator token, KAI scheduling, Karpenter provisioning, and GPU runtime path are reproducible.

### Validated Robotics Workflows

- OSMO CPU and GPU smoke workflows.
- NVIDIA GR00T fine-tuning workflows with retained checkpoints and validation artifacts.
- OpenPI LoRA fine-tuning examples.
- Cosmos Reason2 NIM and Cosmos augmentation examples.
- Isaac Lab and RSL-RL validation examples.
- A multistage nut pouring pipeline adapted from the upstream OSMO cookbook.

### Reproducibility

- Version pins and compatibility notes in `versions.yaml` and `docs/`.

## Repository Layout

```text
infra/core/        AWS reference architecture IaC
infra/ingress/     Optional HTTPS admin ingress for OSMO UI
infra/observability/ Optional AMP and AMG observability root
scripts/           preflight, deploy, validate, submit, cleanup, destroy wrappers
examples/          self-contained OSMO example workflows, docs, and validation artifacts
docs/              architecture, observability, reproducibility, security, version matrix, compatibility
versions.yaml      pinned external versions and tested ranges
```

## Prerequisites

- AWS CLI v2, Terraform, kubectl, Helm, jq, curl, git, and the OSMO CLI.
- An NGC API key with access to the pinned OSMO images in `nvcr.io/nvidia/osmo`.
- A Hugging Face token in `HF_TOKEN`, or `HF_TOKEN_FILE` pointing at a readable token file, for the full nut pouring pipeline.

Provide the NGC API key as an environment variable or a local key file before running `scripts/preflight.sh` or `scripts/deploy-osmo.sh`:

```bash
export NGC_API_KEY="<your-ngc-api-key>"
```

The deploy wrapper also accepts a raw key in `~/.nvidia`, or another file path through `NGC_API_KEY_FILE`. Do not commit NGC key files.

## Quick Start

```bash
cp infra/core/terraform.tfvars.example infra/core/terraform.tfvars
scripts/preflight.sh
scripts/deploy-infra.sh
scripts/deploy-karpenter.sh
scripts/deploy-gpu-operator.sh
scripts/deploy-efa-device-plugin.sh
scripts/deploy-osmo.sh
scripts/validate-platform.sh
scripts/smoke-test.sh
```

`scripts/smoke-test.sh` submits `examples/osmo-smoke/workflow.yaml` by default. For the GPU smoke workflow, prewarm a G7e node so OSMO resource validation can observe GPU platform capacity:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

Validated example workflows live under [examples/](examples/README.md). Each example folder keeps its workflow definition, run instructions, and validation artifacts together.

For local UI access, keep the UI port-forward open:

```bash
kubectl -n osmo port-forward svc/osmo-ui 9001:80
```

Then open <http://127.0.0.1:9001>. The default UI deployment proxies API requests from the UI pod to `osmo-service:80`. Override
`OSMO_UI_API_HOSTNAME` before `scripts/deploy-osmo.sh` if using a different private endpoint.

For local CLI or direct API access, keep a separate API port-forward open:

```bash
kubectl -n osmo port-forward svc/osmo-service 9000:80
```

## EFA Modes

The baseline installs the AWS EFA device plugin so EFA-capable G7e nodes can expose `vpc.amazonaws.com/efa`. Installing the plugin is safe on clusters or nodes without EFA support: the upstream chart only schedules the DaemonSet on supported instance labels, so unsupported instances such as `g7e.2xlarge` and `g7e.4xlarge` simply do not register an EFA resource.

Use EFA-enabled mode when a workflow explicitly needs EFA or NCCL/RDMA validation:

```bash
scripts/deploy-efa-device-plugin.sh
GPU_PREWARM_INSTANCE_TYPE=g7e.12xlarge scripts/prewarm-gpu-node.sh
OSMO_VALIDATE_EFA_DEVICE_PLUGIN=true \
  OSMO_VALIDATE_EFA_NODE=true \
  scripts/validate-platform.sh
```

For multi-node EFA validation, run the Kubernetes-native NCCL benchmark:

```bash
KUBE_CONTEXT=<your-context> examples/g7e-efa-nccl-benchmark/run.sh
```

That NCCL benchmark is a transport check. Its in-place and out-of-place
all-reduce lines differ only in whether the input and output buffers share the
same memory, so similar performance is expected. To compare training wall-clock
with and without EFA, run the DDP benchmark:

```bash
KUBE_CONTEXT=<your-context> examples/g7e-efa-ddp-benchmark/run.sh
```

The validated DDP run used two `g7e.12xlarge` nodes, one GPU per node, and a
256 MiB gradient payload per rank. EFA used NCCL Libfabric/GDRDMA and completed
12 measured steps in `0.129 s`; the non-EFA comparison forced `NCCL_NET=Socket`
and completed the same steps in `1.371 s`.

The core Terraform module opens self-referenced all-traffic ingress and egress
on the EKS node security group because EFA/NCCL traffic requires node-to-node
communication beyond ordinary Kubernetes pod TCP ports.

Use EFA-disabled mode for ordinary single-node GPU examples or smaller G7e sizes. In that mode, skip `scripts/deploy-efa-device-plugin.sh`, do not request `vpc.amazonaws.com/efa` in workflow pod resources, and leave `OSMO_VALIDATE_EFA_NODE=false`.

Destroy the reference environment when finished:

```bash
scripts/destroy.sh
```

## Current Scope

This reference focuses on the AWS integration layer for NVIDIA OSMO. It is not a general-purpose NVIDIA robotics platform distribution; it demonstrates repeatable AWS infrastructure, EKS GPU scheduling, OSMO deployment, and validated workflow execution for NVIDIA robotics and physical AI workloads.

The current baseline uses S3-backed OSMO workflow and dataset storage plus per-workflow ephemeral task storage.

HTTPS admin UI access is optional under `infra/ingress`. That Terraform root installs AWS Load Balancer Controller, requests an ACM certificate, creates an ALB-backed Kubernetes Ingress for `osmo-ui`, and publishes a Route 53 record. It requires an explicit domain name, hosted zone ID, and non-public source CIDR allow list.

For AWS managed observability, see [infra/observability/](infra/observability/README.md) and [docs/observability.md](docs/observability.md). The deployable path maps OSMO's Prometheus and Grafana observability flow to Amazon Managed Service for Prometheus and Amazon Managed Grafana.

The full NVIDIA nut pouring cookbook is treated as an external pinned dependency. Run it through the wrapper after the GPU smoke path succeeds:

```bash
export HF_TOKEN_FILE="$HOME/.huggingface/token"
scripts/run-nut-pouring.sh
```

The nut pouring wrapper prewarms a `g7e.24xlarge` by default because the upstream GR00T fine-tune workflow requests `cpu: 64`, `memory: 512Gi`, and `gpu: 1`. The wrapper preserves upstream resource requests, adds the AWS G7e OSMO platform, removes only the interactive `sleep infinity` hold from step 01 so the six-step run can complete unattended, and verifies Karpenter GPU node cleanup when the workflow finishes.

For bounded validation of the Cosmos augmentation path, set `NUT_POURING_MAX_DEMOS=1` or another small value. Leave it unset for the full upstream cookbook run.

For ad hoc GPU cleanup checks, run:

```bash
scripts/wait-gpu-node-cleanup.sh
```

## Upstream Strategy

NVIDIA OSMO remains external and pinned. This repo uses NVIDIA Terraform and documentation only as reference material. AWS-specific implementation, security defaults, deployment scripts, and validation records belong here.

See [docs/osmo-compatibility.md](docs/osmo-compatibility.md) for the AWS compatibility note related to [NVIDIA/OSMO PR #894](https://github.com/NVIDIA/OSMO/pull/894).

Validation records are kept next to the workflow or optional infra root they
validate, for example `examples/<name>/validation.md` and
`infra/ingress/README.md`.
