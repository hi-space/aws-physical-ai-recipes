# scripts/eks: EKS-Side Installers

> 한국어 문서: [README.ko.md](README.ko.md)

Everything here runs **outside CDK**. `cdk destroy` does not remove any of it, so each installer has
a matching `delete-*.sh`, and several of these bill continuously (ALB, WAF, CloudFront, AMP, EBS).

Run from the `hyperpod-training/` directory, not from here:

```bash
./scripts/eks/kubeconfig.sh
```

## Two observability paths

Pick one. They are alternatives, not layers.

```
install-observability.sh      AMP + the amazon-sagemaker-hyperpod-observability add-on + Grafana.
                              The add-on is not offered in every region (absent in ap-northeast-2).

install-dashboard-public.sh   kube-prometheus-stack + DCGM exporter + Grafana, all in-cluster,
                              published on one CloudFront URL. The path for regions without the
                              add-on, and what the workshop uses in Seoul.
```

The add-on is deliberately outside the CDK stack: in an unsupported region `CreateAddon` returns 400
and CloudFormation rolls the whole stack back, taking the VPC, FSx, and HyperPod cluster with it.

## Install order for the in-cluster path

Order matters. Each script checks its prerequisites and stops with the name of the one to run first.

```bash
./scripts/eks/install-dashboard-public.sh      # ~25 min  ALB + WAF + CloudFront + Grafana + Prometheus + DCGM
./scripts/eks/install-mlflow-selfhosted.sh     # ~10 min  MLflow + Postgres + TensorBoard, same ALB
./scripts/eks/install-unified-dashboard.sh     # ~3 min   one landing page in front of all of them
./scripts/eks/install-dashboard-hardening.sh   # ~10 min  (optional) persist metrics + send alerts
./scripts/eks/install-job-portal.sh            # ~8 min   (optional) submit jobs from the browser
./scripts/eks/install-logs.sh                  # ~8 min   (optional) keep finished-Job logs in S3
```

Why that order:

- `install-dashboard-public.sh` brings Prometheus and Grafana up on `emptyDir` with 6h retention,
  because no gp3 StorageClass exists yet.
- `install-mlflow-selfhosted.sh` installs the EBS CSI add-on and the gp3 StorageClass. Every later
  script that wants a PVC depends on this one having run.
- `install-dashboard-hardening.sh` then moves Prometheus and Grafana onto gp3 PVCs. It must come
  after both, since Grafana keeps alert state in its own DB and would lose it on `emptyDir`.

Delete in reverse:

```bash
./scripts/eks/delete-logs.sh
./scripts/eks/delete-job-portal.sh
./scripts/eks/delete-dashboard-hardening.sh
./scripts/eks/delete-unified-dashboard.sh
./scripts/eks/delete-mlflow-selfhosted.sh
./scripts/eks/delete-dashboard-public.sh       # the ALB survives while any Ingress in the group remains
```

## One ALB, one CloudFront, four UIs

Every Ingress joins the `hyperpod-dashboard` IngressGroup, so the installers share a single load
balancer and distribution instead of each creating its own.

```
https://<cloudfront-domain>/             Grafana      cluster health, and the home dashboard
                  /mlflow                MLflow       training metrics and the Model Registry
                  /tensorboard           TensorBoard  fallback for runs missing from MLflow
                  /argo                  Argo         submit and watch jobs
```

## Files

| File | Role |
|---|---|
| `kubeconfig.sh` | Points `kubectl` at `hyperpod-eks-<account>` and checks nodes and add-ons. Run this first |
| `install-observability.sh` · `delete-observability.sh` | AMP workspace + the observability add-on + Grafana — in-cluster Helm by default, Amazon Managed Grafana with `--grafana amg`. The AMP workspace bills even when empty, so delete it before `cdk destroy` |
| `grafana-user.sh` | Grants an IAM Identity Center user ADMIN on the Managed Grafana workspace. Only needed on the `--grafana amg` path, which starts with no users at all (`--role ADMIN\|EDITOR\|VIEWER`) |
| `install-dashboard-public.sh` · `delete-dashboard-public.sh` | The in-cluster dashboard stack: kube-prometheus-stack, DCGM exporter, Grafana, ALB, WAF (us-east-1 / CLOUDFRONT scope), CloudFront. ALB inbound 80 is restricted to CloudFront's origin-facing prefix list, and TLS terminates at CloudFront. Deletion takes 15-25 min, mostly CloudFront propagation |
| `install-mlflow-selfhosted.sh` · `delete-mlflow-selfhosted.sh` | MLflow 3.16 (Postgres 17 on gp3, artifacts in the stack's S3 bucket, basic auth) + TensorBoard reading `/fsx/checkpoints` read-only. Also installs the EBS CSI add-on and the gp3 StorageClass later scripts need. Deletion keeps data by default (`--purge-db`, `--purge-artifacts`, `--purge-all`, `--remove-ebs-csi`) |
| `install-unified-dashboard.sh` · `delete-unified-dashboard.sh` | Makes the Training Console the Grafana home dashboard and adds a read-only MLflow Postgres datasource, so MLflow run counts and training loss render inside Grafana |
| `install-dashboard-hardening.sh` · `delete-dashboard-hardening.sh` | Prometheus on a 50Gi gp3 PVC with 15d retention, Grafana on its own PVC, plus an SNS topic, pod identity, and four provisioned alert rules. Grafana restarts with the `Recreate` strategy, so expect brief downtime |
| `install-job-portal.sh` · `delete-job-portal.sh` | Argo Workflows + nine WorkflowTemplates at `/argo`. Each submit step calls the same `k8s-templates/render.sh` as the CLI path, so there is one definition of every job. `vla-eval-gate` chains eval → gate, and a BLOCK fails the workflow. Running Workflows are cut off during deletion (`--purge-jobs`, `--remove-crds`) |
| `install-logs.sh` · `delete-logs.sh` | Loki (SingleBinary, chunks in `s3://<data-bucket>/loki/`) + a Grafana Alloy DaemonSet + a `Loki` datasource, so a finished Job's logs outlive the reaped pod. S3 contents are kept on delete unless `--purge-s3` |
| `create-governance.sh` · `delete-governance.sh` | Cluster policy (priority classes training/inference/background, FairShare) + per-team compute quota. No CloudFormation resource type exists for these, hence the CLI. **Leaving them in place blocks HyperPod cluster deletion**, so run the delete script before `cdk destroy` |
| `dcv-target.sh` | Prints the GPU node's SSM target and the DCV port-forwarding command. HyperPod SSM targets are `sagemaker-cluster:<cluster-id>_<instance-group>-<ec2-id>` (`--group`, `--local-port`) |

Every script takes `--cluster`, defaulting to `hyperpod-eks-<account-id>`.

Region handling is not uniform. `kubeconfig.sh`, `install-observability.sh`,
`delete-observability.sh`, `grafana-user.sh`, `create-governance.sh`, and `delete-governance.sh`
take `--region` and otherwise resolve it from the environment. `dcv-target.sh` resolves it from the
environment with no flag. The remaining twelve pin `REGION="ap-northeast-2"` in the script and need
an edit to run anywhere else.

Every `install-*` and `delete-*` script prompts before making changes and takes `--yes` (or `-y`) to
skip the prompt — except `install-observability.sh` and `delete-governance.sh`, which do not prompt
at all.

## Cost

The in-cluster path leaves resources billing after the workshop ends. ALB, WAF, and CloudFront bill
whether or not anyone opens the dashboard, and an AMP workspace bills with no metrics in it. Run the
matching `delete-*.sh` rather than relying on `cdk destroy`.
