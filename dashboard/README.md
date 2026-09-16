# Physical AI Dashboard

An NVIDIA OSMO-style control plane for the Physical AI workshop infrastructure in this repository, built
natively on AWS. One web app replaces the `kubectl` / `sbatch` / SSM / `aws s3 sync` / port-forward toil
of the workshop with workflows, datasets, compute, queues, metrics, experiments, sessions and edge
deployment pages, behind Amazon Cognito on an Application Load Balancer.

> 한국어 요약: HyperPod EKS/Slurm, SageMaker(GR00T 파인튜닝, MLflow), DCV 워크스테이션, Greengrass 엣지를
> 하나의 웹 대시보드에서 OSMO 스타일 워크플로(YAML DAG)로 구성·실행·모니터링합니다. Next.js 16.3.5 +
> ECS Fargate + ALB/Cognito + DynamoDB로 배포되며, 형제 스택(`HyperPodEks-*`, `HyperPod-*`, `GrootFinetune-*`,
> `IsaacLab-*`)의 CloudFormation 출력을 자동 탐색해 연결합니다.

## What you get

| Page | What it does | AWS behind it |
|---|---|---|
| Overview | GPU/node capacity, workflow & queue counters, recent events, 30-day cost, controller health | SageMaker HyperPod, EKS, Kueue, Cost Explorer |
| Workflows | Template gallery → parameter form → YAML (OSMO-compatible spec) → submit; DAG view, live logs (SSE), events, per-pod GPU/CPU metrics, dataset outputs, export/clone/retry/cancel | Kubernetes Jobs on HyperPod EKS with Kueue labels, DynamoDB state, CloudWatch (historical logs), AMP |
| Jobs & Pods | Every batch Job in user namespaces, including ones created with `kubectl`; logs, delete, cluster events | EKS API |
| Queues & Quotas | Kueue ClusterQueues/LocalQueues/flavors/priorities with usage vs quota; SageMaker cluster policy and compute quotas (create/delete) | Kueue CRDs, SageMaker task governance |
| Compute | HyperPod EKS and Slurm clusters: instance groups with scale controls, node health, cluster events, add-ons, FSx for Lustre + data-repository tasks | SageMaker `UpdateCluster`, EKS, FSx |
| Metrics | GPU (DCGM), node, Kueue and capacity charts with a time-range picker; embedded Grafana | Amazon Managed Prometheus; self-hosted Grafana proxied through the Kubernetes API server |
| Experiments | Experiments, runs, metric curves, params, compare; open the MLflow UI | SageMaker managed MLflow (SigV4 REST) |
| Datasets | Named, versioned S3 prefixes with lineage; browser upload; Hugging Face import template; mountable in workflows via FSx DRA | S3, FSx for Lustre, DynamoDB |
| Models | SageMaker fine-tune outputs, EKS checkpoints, Model Registry, MLflow models; deploy to edge | S3, SageMaker, MLflow |
| Sessions | DCV workstation start/stop/credentials, HyperPod GPU-node DCV port-forward helper, TensorBoard on FSx logdirs | EC2, Secrets Manager, EKS (proxied Deployments) |
| SageMaker Pipelines | Start `groot-sm-finetuning-<acct>` with parameters, step graph, training-job metrics and logs | SageMaker Pipelines, CloudWatch Logs |
| Edge | Greengrass core devices, deployments, components; deploy the GR00T policy server with a chosen model | AWS IoT Greengrass v2 |
| Storage | S3 browser for the data/artifacts buckets, FSx status and export/import tasks | S3, FSx |
| Admin | Cognito users & groups, audit log, notification settings, discovered configuration, controller status | Cognito, DynamoDB, SNS |

Roles come from Cognito groups: `admins` (everything), `researchers` (submit/cancel own workflows,
datasets, sessions, uploads), `viewers` (read-only). Every mutation is written to the audit log.

## Architecture

```
Browser ─HTTPS─▶ ALB (ACM cert, authenticate-cognito) ─▶ ECS Fargate: Next.js 16.3.5 (UI + API + workflow controller)
                                                             │ task role (EKS access entry, SigV4)
     EKS API · SageMaker · AMP · SageMaker MLflow · S3 · FSx · CloudWatch · EC2 · Greengrass · Cognito · DynamoDB · SNS
```

- **Workflow spec** — an OSMO-compatible YAML subset (`workflow.resources`, `tasks[].inputs/outputs/files/
  credentials/parallelism/retry`, `default-values` + `{{ var }}` templating, `{{output}}`/`{{input:N}}`
  placeholders). Each task compiles to a Kubernetes Job (FSx PVC at `/fsx`, files via ConfigMap,
  credentials from allow-listed SSM parameters via a per-Job Secret, Kueue queue/priority labels for
  `hyperpod-ns-*` namespaces). A controller loop (single holder of a DynamoDB lease) advances the DAG,
  applies queue timeouts, publishes `outputs` as dataset versions (FSx `/checkpoints` is exported to S3 by
  the data repository association) and notifies via SNS. See
  `web/src/server/workflow/` and the built-in templates in `builtin-templates.ts`.
- **Discovery** — `infra/bin/app.ts` reads the outputs of `HyperPodEks-<acct>`, `HyperPod-<acct>`,
  `GrootFinetune-<acct>` and `IsaacLab-*-<acct>` at synth time and injects them as container environment
  (contract: `web/src/server/config.ts` ↔ `infra/lib/env-contract.ts`). Missing stacks simply disable the
  corresponding pages.
- **Slurm** — managed (instance groups, scaling, events, DCV targets) but not scheduled: HyperPod Slurm nodes
  only accept SSM `start-session`, so workflows run on the EKS orchestrator.

## Deploy

Prerequisites: the HyperPod EKS stack (`hyperpod-training/infra`, `-c orchestrator=eks`) is deployed in the
target region (its VPC hosts the dashboard); a Route 53 public hosted zone you control (ALB + Cognito needs
HTTPS); Docker; Node.js 22; CDK bootstrap.

```bash
cd dashboard/infra && npm install
npx cdk deploy \
  -c domainName=physical-ai.example.com \
  -c hostedZoneId=Z0123456789ABC -c hostedZoneName=example.com \
  -c adminEmail=you@example.com \
  -c notifyEmail=you@example.com   # optional SNS e-mail
```

~10 minutes (Docker image build + ACM DNS validation). Outputs:

- `DashboardUrl` — `https://<domainName>/`
- `AdminCredentialsCommand` — prints the bootstrap admin username/password from Secrets Manager
  (`physical-ai-dashboard/<acct>/admin`). Create more users on the Admin page.

The stack name is `PhysicalAiDashboard-<accountId>`. Redeploy after deploying a new sibling stack so the
discovery picks it up. `npx cdk destroy` removes everything including the DynamoDB table (workflow history
and dataset registry) and Cognito user pool.

### Optional wiring

- **Workflow pod identity** — HyperPod EKS nodes block IMDS from pods, so the stack creates the
  `physical-ai-dashboard-<acct>-workflow-pods` IAM role (S3 on the discovered buckets, `sagemaker-mlflow:*`,
  SSM credential prefixes) and EKS Pod Identity associations for the `pai-workflow` ServiceAccount in
  `-c workflowNamespaces` (default `rl,hyperpod-ns-team-a,hyperpod-ns-team-b`). The controller creates that
  ServiceAccount and sets it on every Job; templates with `mlflow: true` also get `MLFLOW_TRACKING_URI`
  (the container needs the `sagemaker-mlflow` plugin).
- **GR00T pipeline** — the `gr00t-pipeline` template is the workshop's SageMaker pipeline
  (`e2e-workshop/groot/pipeline`) on EKS: `prepare-data` (HF download, v3→v2.1, validation, modality config)
  → `finetune` (groot-sm-training image, 1 GPU, HF Trainer → MLflow) → `evaluate` (smoke check + upstream
  open-loop MSE, `evaluation.json` + plots, exit code = gate) → `register` (inference-only export to
  `s3://<artifacts>/models/groot-sm/wf-<id>/` for IsaacSim/DCV, MLflow model version + alias). Each stage
  publishes a dataset version, so lineage runs from the HF dataset to the registered model.
- **Credentials** — put tokens in SSM SecureString parameters under `/groot/`, `/physical-ai/` or `/pai/`
  (e.g. `aws ssm put-parameter --name /groot/hf-token --type SecureString --value hf_...`) and reference
  the path in `credentials:`.

## Develop

```bash
cd dashboard/web && npm install
AUTH_MODE=dev npm run dev          # in-memory store, admin user, AWS calls with your local credentials
npm test                           # Vitest unit tests (spec, compiler, controller, auth, store)
npm run typecheck && npm run build
DASHBOARD_URL=https://... DASHBOARD_PASSWORD=... npx playwright test   # live smoke test through Cognito
```

Set the same env vars the CDK stack injects (see `src/server/config.ts`) to point a dev server at real
clusters, e.g. `EKS_CLUSTER_NAME`, `HYPERPOD_EKS_CLUSTER_NAME`, `EKS_DATA_BUCKET`, `AMP_WORKSPACE_ID`,
`MLFLOW_TRACKING_SERVER_ARN`, `ARTIFACTS_BUCKET`, `DCV_INSTANCE_ID`, `DCV_SECRET_ARN`.

## Layout

```
dashboard/
├── web/     Next.js 16.3.5 — src/app (pages + api routes), src/components, src/server (aws, k8s, workflow, store, auth)
└── infra/   CDK — bin/app.ts (discovery), lib/dashboard-stack.ts, lib/constructs/{auth,service,table}.ts
```
