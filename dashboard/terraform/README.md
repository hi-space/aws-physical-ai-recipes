# Physical AI Dashboard — Terraform deployment

Terraform equivalent of the CDK stack in `../infra`. It creates the same control plane
(ECS Fargate web/controller/gateway behind an ALB with Cognito, DynamoDB, S3 artifact archive,
SQS/Step Functions run lifecycle, CodeBuild operations and source builds, EKS access entries and
Pod Identity) and builds the same container images with the local Docker daemon. Nothing about the
deployment domain is hard-coded: the public origin, the session-host domain and the Cognito hosted UI
domain are all derived from `domain_name` / `cognito_domain_prefix` and handed to the containers
through the environment contract below.

## Prerequisites

- Terraform ≥ 1.6, AWS credentials for the target account, Docker (BuildKit) and Python 3 on the
  machine running `terraform apply` (images are built locally and pushed to ECR).
- An existing HyperPod EKS cluster stack (default discovery: `HyperPodEks-<account>`), a VPC with at
  least two public and two private subnets, and a Route 53 hosted zone for `domain_name`.
- Cluster add-ons/RBAC are applied by the `<prefix>-operations` CodeBuild project (`infra/ops/apply_addons.py`);
  start it once after the first apply (`aws codebuild start-build --project-name <prefix>-operations`).

```bash
cd dashboard/terraform
cp environments/validation.tfvars.example environments/mine.tfvars   # edit
terraform init
terraform apply -var-file=environments/mine.tfvars
terraform output admin_credentials_command
```

The first apply builds `web` (Next.js), `runtime` (Go), `workspace` and the MuJoCo/Isaac Lab/ROS 2
workload images (add `extended_images = true` for GR00T/OpenPI). Rebuilds happen only when the
content hash of a build context changes; `image_overrides` skips a build and uses a published URI.

## Without a custom domain

`domain_name` is optional. Leave it (and `hosted_zone_id`) empty and the dashboard is served on the
ALB DNS name with a self-signed certificate imported into ACM: Cognito login and every workflow,
dataset, artifact and model feature work, but browsers show a certificate warning and there are no
`*.apps` session hosts, so the gateway is not deployed and TensorBoard/terminal/file/live-view/DCV
sessions are disabled (`features.sessions=false`, the UI explains why). Set `admin_email` explicitly
in this mode. Adding a domain later is a normal `apply`.

## Running two deployments in one account

Every named resource derives from `name_prefix`; leave it empty for the CDK-compatible
`physical-ai-dashboard-<account>` names, or set it (e.g. `pai-tf-<account>`) to run next to an
existing stack. Also choose a distinct `domain_name`, `cognito_domain_prefix` and
`workflow_pod_identity_service_account` (one Pod Identity association per namespace/service account).
Kubernetes RBAC groups (`physical-ai:web|controller|gateway`), network policies and Kueue queues are
cluster-wide and shared.

## Environment contract

`terraform output environment_contract` prints the web container environment. Source of truth:
`infra/lib/env-contract.ts` (discovered stacks) plus `locals.tf` here. Summary:

| Variable | Set from | Used by |
|---|---|---|
| `AWS_REGION`, `ACCOUNT_ID` | provider | all |
| `AUTH_MODE=alb`, `WORKFLOW_CONTROLLER=0` | fixed | all (controller/gateway run their own entrypoints) |
| `TABLE_NAME`, `WORKFLOW_CALLBACKS_TABLE` | DynamoDB tables | all |
| `SNS_TOPIC_ARN`, `WORKFLOW_STATE_MACHINE_ARN`, `WORKFLOW_QUEUE_URL` | orchestration | web, controller |
| `DASHBOARD_ARTIFACT_BUCKET` | artifact bucket | all |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `ALB_ARN` | auth/ALB | web (`COGNITO_DOMAIN` drives `/api/logout`) |
| `DASHBOARD_ORIGIN` | `https://<domain_name>` | web, gateway (origin checks, DCV frame policy) |
| `GATEWAY_BASE_DOMAIN` | `apps.<domain_name>` | gateway, web (session host names) |
| `RUNTIME_API_URL` | `http://controller.<prefix>.internal:3001` | workload runtime wrapper |
| `TASK_RUNTIME_IMAGE`, `WORKSPACE_IMAGE_URI`, `MUJOCO_IMAGE_URI`, `ISAACLAB_IMAGE_URI`, `ROS2_IMAGE_URI`, (`GROOT_RUNTIME_IMAGE_URI`, `OPENPI_IMAGE_URI`) | built or overridden images | all |
| `IMAGE_PROFILES_ENFORCED=1`, `LOG_ARCHIVE_ENABLED=1` | fixed | all |
| `SOURCE_BUILD_TARGETS_JSON`, `BUILD_PROJECTS` | CodeBuild projects | web, controller |
| `EKS_CLUSTER_NAME`, `HYPERPOD_EKS_CLUSTER_NAME`, `EKS_DATA_BUCKET`, `FSX_*`, `AMP_WORKSPACE_ID`, `BACKEND_HOME_VPC_ID`, `EKS_BACKENDS_JSON` | HyperPod EKS stack | all |
| `HYPERPOD_SLURM_CLUSTER_NAME`, `SLURM_*` | HyperPod Slurm stack | web |
| `ARTIFACTS_BUCKET`, `MLFLOW_TRACKING_SERVER_*`, `SM_*` | GR00T stack | web, controller |
| `DCV_INSTANCE_ID`, `DCV_SECRET_ARN`, `DCV_URL`, `CODE_SERVER_URL`, `DCV_SSO_SECRET_ARN`, `DCV_AGENT_ASSET_URI` | Isaac Lab stack | web, gateway |
| `GREENGRASS_THING_GROUP`, `GREENGRASS_INFERENCE_COMPONENT` | convention `groot-<account>` | web |
| `RUNTIME_SIGNING_KEY` (secret) | Secrets Manager `<prefix>/runtime-signing` | controller |

Empty values are dropped, so features whose stack is absent are simply disabled.

## Differences from the CDK stack

- Image assets → one ECR repository per image under `<prefix>/…`, tagged by build-context hash.
- The CDK asset bucket → `<prefix>-assets-*` (operations source, source-build snapshot, DCV agent).
- Cognito bootstrap admin → native `aws_cognito_user` (no custom resource Lambda).
- Controller task defaults to 2 vCPU / 4 GiB (`controller_cpu`, `controller_memory_mib`).
- Optional Cosmos/LeIsaac images are not built here; pass their URIs via `extra_environment`.

`terraform destroy` removes everything except a non-empty artifact archive; set
`artifact_bucket_force_destroy = true` (validation environments) or empty the bucket first.
