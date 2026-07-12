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
scripts/deploy-osmo-sso-bootstrap.sh   # first SSO deploy: see note below
scripts/validate-platform.sh
scripts/smoke-test.sh
```

The 6.3.1 SSO gateway has a bootstrap ordering problem: `deploy-osmo.sh`
requires the `infra/cloudfront` `osmo_ui_cloudfront_domain` output, but
`infra/cloudfront` needs the `osmo-gateway` Service LoadBalancer that only
exists after OSMO is deployed. `scripts/deploy-osmo-sso-bootstrap.sh` breaks the
cycle: it applies `infra/cognito` with a placeholder callback, runs
`deploy-osmo.sh` once to create the gateway LoadBalancer, applies
`infra/cloudfront` with that LoadBalancer as origin, then re-applies
`infra/cognito` and re-runs `deploy-osmo.sh` with the real CloudFront hostname.
On later deploys, once the CloudFront domain is stable, you can run
`scripts/deploy-osmo.sh` directly. For a non-default region, export
`TF_WORKSPACE` and point `COGNITO_VAR_FILE` / `CLOUDFRONT_VAR_FILE` at the
matching `terraform.<region>.tfvars`.

`scripts/smoke-test.sh` submits `examples/osmo-smoke/workflow.yaml` by default. For the GPU smoke workflow, prewarm a G7e node so OSMO resource validation can observe GPU platform capacity:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

The GPU smoke path depends on live G7e (RTX PRO 6000) On-Demand capacity.
`prewarm-gpu-node.sh` forces Karpenter to launch a real G7e node so OSMO
registers the GPU platform before submission; without a registered node, OSMO
rejects the workflow with `no resources in platform`. Karpenter always tries the
cheapest instance type first (e.g. `g7e.2xlarge`) and does not auto-escalate to
a larger size on `InsufficientInstanceCapacity`, so if AWS has no On-Demand G7e
in the pool's AZs the node never appears. Spread the pool across more AZs (see
below) or retry when capacity recovers.

Validated example workflows live under [examples/](examples/README.md). Each example folder keeps its workflow definition, run instructions, and validation artifacts together.

### Multi-region G7e AZ selection

G7e (RTX PRO 6000) is offered in different — sometimes non-contiguous — AZs per
region, and On-Demand capacity in a single AZ can exhaust. `infra/core/main.tf`
carries a `g7e_azs_by_region` map so AZ selection resolves in this order:
explicit `availability_zones` var → region map lookup → discovered AZs. Leaving
`availability_zones = []` delegates to the map. Current pins: `ap-northeast-2`
= `[a, b]`, `us-east-1` = `[b, d]` (non-contiguous), `us-east-2` = `[a, b]`,
`us-west-2` = `[a, b, c, d]`.

To let GPU nodes fall back across AZs when one is capacity-constrained, spread
the Karpenter private subnets wider than the EKS/stateful footprint. EKS + RDS
stay on the first `az_count` AZs; Karpenter subnets span `karpenter_az_count`:

```hcl
availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d"]
az_count           = 2   # EKS + RDS on a/b
karpenter_az_count = 4   # GPU nodes may land in a/b/c/d
```

Per-region starting points are in `infra/core/terraform.<region>.tfvars.example`
(`use1`, `use2`, `usw2`), each with a region-suffixed `project_name` so
account-global IAM names do not collide across a same-account multi-region
deploy.

### Accessing the OSMO UI over HTTPS with Cognito SSO

The `deploy-osmo-sso-bootstrap.sh` path publishes the OSMO UI behind CloudFront
(`https://<osmo-ui-cloudfront-domain>`) with Amazon Cognito single sign-on. In
6.3.1 the UI, API gateway, envoy, and oauth2-proxy are merged into the
`osmo-service` release; unauthenticated requests are redirected to the Cognito
hosted login UI, and after login oauth2-proxy establishes the session.

Access is restricted at two layers: the `infra/cloudfront` WAF IP allow list
gates who can reach the distribution at all, and Cognito gates who can log in.
The initial login user is provisioned automatically: set `admin_email` and
`admin_password` in `infra/cognito/terraform.tfvars`, and the bootstrap creates
the Cognito user (permanent password, no temp-password email) while
`deploy-osmo.sh` grants that identity the `osmo-admin` role in OSMO. The first
SSO login therefore already has full admin access with no manual steps.

To add more users later — or if you left `admin_email` empty to manage users by
hand — create them with the admin API and grant OSMO roles by Cognito sub:

```bash
POOL=$(terraform -chdir=infra/cognito output -raw user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --password '<choose-a-strong-password>' --permanent
```

Users created this way sign in with `osmo-default` only; grant them more with
`osmo user update <cognito-sub> --add-roles osmo-admin`. Open
`https://<osmo-ui-cloudfront-domain>` from a whitelisted IP and sign in with the
username and password. Retrieve the domain any time with:

```bash
terraform -chdir=infra/cloudfront output -raw osmo_ui_cloudfront_domain
```

### Local access without SSO

For local UI access, keep the UI port-forward open:

```bash
kubectl -n osmo port-forward svc/osmo-ui 9001:80
```

Then open <http://127.0.0.1:9001>. The default UI deployment proxies API requests from the UI pod to `osmo-service:80`. Override
`OSMO_UI_API_HOSTNAME` before `scripts/deploy-osmo.sh` if using a different private endpoint.

For local CLI or direct API access, keep a separate API port-forward open. In
6.3.1 `osmo-service:80` serves self-signed TLS only, so the plaintext OSMO CLI
login path must go through `osmo-internal-router` (the no-auth plain-HTTP route
to the API):

```bash
kubectl -n osmo port-forward svc/osmo-internal-router 9000:80
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

For domain-free HTTPS access, `infra/cloudfront` places CloudFront distributions in front of both the OSMO UI ALB and the Grafana ALB. A shared WAF WebACL restricts access to whitelisted IPs only. CloudFront's default `*.cloudfront.net` certificate eliminates browser certificate warnings without requiring a custom domain or Route 53 hosted zone. After deployment, update the OSMO backend to point at the Grafana CloudFront URL:

```bash
GRAFANA_URL=https://<grafana-cloudfront-domain>.cloudfront.net scripts/update-grafana-url.sh
```

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
