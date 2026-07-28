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
docs/              architecture, GPU capacity/region fallback, observability, reproducibility, security, version matrix, compatibility
versions.yaml      pinned external versions and tested ranges
```

## Prerequisites

- AWS CLI v2, Terraform, kubectl, Helm, jq, curl, git, and the OSMO CLI.
- An NGC API key with access to the pinned OSMO images in `nvcr.io/nvidia/osmo`.
- A Hugging Face token in `HF_TOKEN`, or `HF_TOKEN_FILE` pointing at a readable token file, for the full nut pouring pipeline.

The OSMO CLI is distributed by NVIDIA (NGC), not vendored here — install it from your NVIDIA OSMO distribution and confirm `osmo --version` works before deploying. Once the platform is up, authenticate against the SSO gateway with `scripts/osmo-cli-login.sh` (see the CLI login section below).

Provide the NGC API key as an environment variable or a local key file before running `scripts/preflight.sh` or `scripts/deploy-osmo.sh`:

```bash
export NGC_API_KEY="<your-ngc-api-key>"
```

The deploy wrapper also accepts a raw key in `~/.nvidia`, or another file path through `NGC_API_KEY_FILE`. Do not commit NGC key files.

## Quick Start

Prepare the three tfvars files (only `allowed_cidrs` in cloudfront is
mandatory; core and cognito have working defaults), then run the whole deploy
with one command:

```bash
cp infra/core/terraform.tfvars.example       infra/core/terraform.tfvars
cp infra/cognito/terraform.tfvars.example     infra/cognito/terraform.tfvars
cp infra/cloudfront/terraform.tfvars.example  infra/cloudfront/terraform.tfvars
# edit infra/cloudfront/terraform.tfvars: set allowed_cidrs to your CIDR(s)

scripts/deploy-all.sh
```

`scripts/deploy-all.sh` runs the eight steps below in dependency order. On
failure it prints the failed step and the exact resume command
(`RESUME_FROM=N scripts/deploy-all.sh`); each step is idempotent so resuming
re-runs it cleanly. Useful knobs: `DRY_RUN=true` prints the plan without
executing, `SKIP_STEPS="5 8"` skips the EFA plugin and CPU smoke test. On
success the orchestrator prints the CloudFront OSMO UI URL directly (resolved
from the `infra/cloudfront` output).

Observability (Grafana) is out of scope for `deploy-all.sh`. The eight steps
deploy OSMO and its SSO gateway but not the AMP/AMG or in-cluster observability
stack, so the SSO bootstrap points the CloudFront Grafana origin at a
placeholder. To publish Grafana behind CloudFront, run `deploy-observability.sh`
(or `deploy-observability-incluster.sh`), re-apply `infra/cloudfront` with
`CLOUDFRONT_GRAFANA_ALB=<grafana-alb-dns>`, then wire the OSMO backend to it with
`GRAFANA_URL=https://<grafana-cloudfront-domain> scripts/update-grafana-url.sh`.

To run the steps by hand (or to understand what the orchestrator does):

```bash
scripts/preflight.sh                   # 1  tooling, creds, tfvars, terraform validate
scripts/deploy-infra.sh                # 2  EKS + RDS + Redis + S3/ECR/KMS/IRSA
scripts/deploy-karpenter.sh            # 3  GPU NodePool(s)
scripts/deploy-gpu-operator.sh         # 4  NVIDIA GPU Operator
scripts/deploy-efa-device-plugin.sh    # 5  EFA device plugin
scripts/deploy-osmo-sso-bootstrap.sh   # 6  OSMO + Cognito SSO + CloudFront (see note)
scripts/validate-platform.sh           # 7  cluster / OSMO / KAI / GPU checks
scripts/smoke-test.sh                  # 8  CPU smoke workflow
```

### Deploy order and dependencies

Each step consumes what the previous ones produce. The key non-obvious edge is
step 6, which resolves a circular dependency (CloudFront ↔ gateway LB ↔ Cognito)
that no single Terraform apply can satisfy:

```
1 preflight ──────────────▶ validates tooling + tfvars, gates everything
2 deploy-infra ──▶ EKS cluster, IRSA roles, RDS/Redis, S3/ECR/KMS
       │                    (kubeconfig + terraform outputs)
       ▼
3 deploy-karpenter ──▶ GPU NodePool(s)   ┐
4 deploy-gpu-operator ──▶ NVIDIA runtime │ all need the cluster from step 2;
5 deploy-efa-device-plugin ──▶ EFA plugin┘ independent of each other
       │
       ▼
6 deploy-osmo-sso-bootstrap ──▶ OSMO (auto-runs deploy-kai.sh) + Cognito + CloudFront
       │   breaks the cycle: cognito(placeholder) → deploy-osmo (creates
       │   gateway LB) → cloudfront(LB origin) → cognito(real domain) → deploy-osmo
       ▼
7 validate-platform ──▶ confirms cluster / OSMO / KAI / GPU runtime
       │
       ▼
8 smoke-test ──▶ submits examples/osmo-smoke/workflow.yaml (needs HF token)
```

KAI Scheduler is not a separate step: `deploy-osmo.sh` auto-runs `deploy-kai.sh`
when `OSMO_INSTALL_KAI=true` (the default). Steps 3–5 all depend only on the
cluster from step 2 and can be reordered among themselves; the EFA plugin
(step 5) is safe to skip on non-EFA setups.

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

### CLI workflow ownership (who submitted a workflow)

`osmo-internal-router` is a no-auth path: it does not verify a Cognito JWT, so
every workflow submitted through the `127.0.0.1:9000` port-forward is recorded
under the service token's identity (the bootstrap `default-admin-token` shows up
as `admin`/`testuser`), not under the human who ran the CLI. That path is only
for deploy-time bootstrap and local smoke tests.

For real users, the workflow owner must be the caller's Cognito `sub`. The
gateway Envoy `jwt_authn` maps the Cognito `sub` claim to `x-osmo-user`
(`deploy-osmo.sh`, `user_claim: sub`), so a CLI call authenticated with a
Cognito ID token through the CloudFront gateway is recorded under that user's
`sub`. Verified live: submitting through
`https://<osmo-ui-cloudfront-domain>` with a user's Cognito ID token records the
workflow owner as that user's `sub`, matching what the web UI's "my workflows"
filter expects.

Note the 6.3.1 CLI login limits: the OSMO API exposes no device-code endpoint
(so `osmo login --method code` does not work against this gateway), and
`osmo login --method token` expects an OSMO refresh token, not a Cognito token.
The working path is to obtain the user's Cognito ID token (Cognito hosted UI /
SRP against the app client) and send it as the `Authorization: Bearer` token to
the gateway. Do not point production CLI users at `osmo-internal-router`, or
their submissions will all collapse into one shared service identity.

`scripts/osmo-cli-login.sh` automates that path: it authenticates the user
against Cognito with SRP (via `pycognito`), then writes
`~/.config/osmo/login.yaml` pointed at the CloudFront gateway so Envoy records
the caller's `sub`.

```bash
pip install pycognito   # one-time, SRP dependency
OSMO_CLI_USER=alice@example.com scripts/osmo-cli-login.sh
# password is read interactively unless OSMO_CLI_PASSWORD is set
osmo workflow query      # now recorded under alice's Cognito sub
```

The machine running it must have its egress IP whitelisted in
`infra/cloudfront` (`allowed_cidr_blocks`) to reach the gateway through the WAF.
Cognito/CloudFront values are read from the `infra/cognito` and
`infra/cloudfront` terraform outputs; override with `OSMO_GATEWAY_URL`,
`OSMO_COGNITO_USER_POOL_ID`, `OSMO_COGNITO_CLIENT_ID`,
`OSMO_COGNITO_CLIENT_SECRET` if terraform state is not local.

## G6 (NVIDIA L4) capacity-fallback path

When g7e (RTX PRO 6000, 96GB) is out of capacity in a region
(`InsufficientInstanceCapacity`), this repo provides a fallback path to G6
(NVIDIA L4, 24GB). The default g7e logic is untouched; the G6 path is opt-in via
environment variables.

```bash
# 1) Create the G6 NodePool (reuses the g7e EC2NodeClass, single-AZ pin)
DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh

# 2) Register the g6-l4 platform in OSMO
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh

# 3) Prewarm a G6 node so OSMO resource validation sees the capacity
GPU_PREWARM_INSTANCE_TYPE=g6.4xlarge \
  KARPENTER_NODEPOOL_NAME=aws-osmo-g6 \
  GPU_PREWARM_NAME=aws-osmo-g6-prewarm \
  scripts/prewarm-gpu-node.sh
```

Defaults live in `versions.yaml`: `karpenter_g6_nodepool_name` (default
`aws-osmo-g6`), `g6_instance_types` (default
`g6.2xlarge,g6.4xlarge,g6.8xlarge,g6.12xlarge`). The AZ defaults to the deploy
region's first AZ (e.g. `us-west-2a`) and can be overridden with
`KARPENTER_G6_ZONE`.

Example workflows validated on G6 nodes:

- `examples/cosmos-reason2-nim/workflow-g6.yaml` — Cosmos Reason2 NIM. Caps the
  context length via `NIM_MAX_MODEL_LEN` (default 32768) to fit L4's 24GB. The
  NIM default 256K context needs ~29GiB of KV cache and fails on L4, so this
  value is the key.
- `examples/isaaclab-rsl-rl-video/workflow-g6.yaml` — Isaac Lab RSL-RL training
  (video rendering disabled).
- `examples/isaaclab-rsl-rl-video/workflow-g6-video.yaml` — same with video
  rendering enabled. Adds `--enable_cameras` to `play.py` so offscreen video
  recording works in a headless environment.
- `examples/gr00t-finetune/workflow-g6.yaml` — GR00T fine-tune (resources and
  tuning scope reduced for L4).
- `examples/gpu-smoke/workflow-g6.yaml` — CUDA burn-in GPU smoke (L4).

Note: L4 (24GB) is sufficient for inference (VLM) workloads such as Cosmos
Reason2, but is not suitable for Cosmos Predict/Transfer diffusion generation
workloads (which need A100/H100/G7e).

### G6e (NVIDIA L40S, 48GB) fallback

When L4's 24GB is not enough but g7e capacity is still unavailable, fall back to
G6e (L40S, 48GB). It works the same way as G6 (dedicated NodePool + OSMO
platform) and reuses the g7e EC2NodeClass.

```bash
# 1) Create the G6e NodePool (single-AZ pin)
DEPLOY_G6E_NODEPOOL=true scripts/deploy-karpenter.sh

# 2) Register the g6e-l40s platform in OSMO
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-osmo.sh

# 3) Prewarm a G6e node
GPU_PREWARM_INSTANCE_TYPE=g6e.4xlarge \
  KARPENTER_NODEPOOL_NAME=aws-osmo-g6e \
  scripts/prewarm-gpu-node.sh
```

Defaults: `karpenter_g6e_nodepool_name` (default `aws-osmo-g6e`),
`g6e_instance_types` (default `g6e.2xlarge,g6e.4xlarge,g6e.8xlarge,g6e.12xlarge`).
Override the AZ with `KARPENTER_G6E_ZONE`. The GPU smoke validation workflow is
`examples/gpu-smoke/workflow-g6e.yaml` (platform `g6e-l40s`).

## Troubleshooting

Issues seen during real deploys and GPU runs, with the fix. `deploy-all.sh` is
idempotent and prints a `RESUME_FROM=N` command on failure, so resume from the
failed step after applying a fix.

### Prewarmed GPU node disappears mid-run ("imminent node shutdown")

A prewarmed node registers GPU capacity via a busybox *hold* pod
(`prewarm-gpu-node.sh`). That hold pod carries no `karpenter.sh/do-not-disrupt`
annotation, so when it exits the node looks Empty and Karpenter consolidates it
(`consolidationPolicy: WhenEmptyOrUnderutilized`, `consolidateAfter: 5m`) —
Karpenter logs `Empty/... delete: nodepools=[...] savings: $…`. This is not AWS
capacity reclamation. Real OSMO workflow pods are unaffected: `deploy-osmo.sh`
stamps them with `karpenter.sh/do-not-disrupt` (`OSMO_GPU_POD_DO_NOT_DISRUPT`,
default `true`). To hold a manually prewarmed node alive during a long
setup/run, temporarily lock the NodePool's disruption budget and restore it
after:

```bash
# lock (no consolidation), do the run, then restore to the default 10%
kubectl patch nodepool <name> --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"0"}]}}}'
kubectl patch nodepool <name> --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"10%"}]}}}'
```

### `kubectl` / OSMO CLI times out against the EKS API

The cluster's public API endpoint is locked to `cluster_endpoint_public_access_cidrs`
(`infra/core/variables.tf`, which also rejects `0.0.0.0/0`). If the operator
host's egress IP is not in that list, every `kubectl`/`osmo` call hangs and
times out. Add the operator's public IP (`/32`) to that var and re-apply
`infra/core`. This is the most common first-call failure on a fresh operator
host or after an IP change.

### `EntityAlreadyExists` / WAF name collision on a same-account, multi-region deploy

IAM role/policy/user names and WAF `WebACL`/`IPSet` names are account-global
(WAF for CloudFront is scoped to `us-east-1`). A second region in the same
account collides with the first. Give each region a distinct `project_name`
(the IAM name prefix) and a distinct CloudFront `name_prefix` (the WAF name
prefix) — the per-region `infra/core/terraform.<region>.tfvars.example` files
already carry region-suffixed values.

### GR00T eval server exits with `MissingCUDAException` / `nvcc not found`

`transformers` imports `deepspeed` whenever it is importable, and deepspeed's
op-compat check shells out to `nvcc`, which the `nvcr.io/nvidia/isaac-lab`
image does not ship (`DS_SKIP_CUDA_CHECK`/`DS_BUILD_OPS` do not bypass it). GR00T
inference needs none of deepspeed, so the eval workflows uninstall it after
`uv sync` and start the server with `uv run --no-sync`. See
[examples/closed-loop-sim-eval/validation.md](examples/closed-loop-sim-eval/validation.md).

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
