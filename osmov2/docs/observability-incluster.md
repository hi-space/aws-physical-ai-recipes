# In-Cluster Observability (Grafana + Prometheus + Pushgateway)

An alternative to the AMP + AMG path in [infra/observability](../infra/observability/README.md),
for accounts **without IAM Identity Center** (Amazon Managed Grafana requires
AWS SSO for browser login). This path runs Grafana in-cluster with id/pw login
and adds a Pushgateway so training workflows push reward/loss metrics into the
same Grafana as DCGM GPU metrics.

Use `infra/observability` (AMP+AMG) for managed, SSO-backed production. Use this
in-cluster path for dev/test or SSO-less accounts.

## What it deploys

- `kube-prometheus-stack` (pinned in `versions.yaml`) with bundled Grafana
  (`grafana.enabled=true`, id/pw login), Prometheus (24h local retention),
  node-exporter, and kube-state-metrics.
- `prometheus-pushgateway` for training metrics push.
- A `ServiceMonitor` for the GPU Operator's DCGM exporter so `DCGM_FI_DEV_*`
  GPU metrics are scraped.

All in the `monitoring` namespace. Chart versions in `versions.yaml` under
`observability_incluster`.

## Deploy

```bash
scripts/deploy-observability-incluster.sh
```

The script generates a Grafana admin password and stores it at
`~/.aws-osmo-grafana-admin` (override with `GRAFANA_ADMIN_PASSWORD`).

## Access

### Local (port-forward)

```bash
# Grafana (GPU metrics + training curves)
kubectl -n monitoring port-forward svc/aws-osmo-observability-grafana 3000:80
# -> http://127.0.0.1:3000   login: admin / (cat ~/.aws-osmo-grafana-admin)

# Prometheus (raw queries)
kubectl -n monitoring port-forward svc/aws-osmo-observability-prometheus 9090:9090
```

### Public HTTPS (optional ALB ingress)

Set these before running the deploy script to also create an internet-facing
ALB ingress (reuses the AWS Load Balancer Controller from `infra/ingress`).
Grafana only has id/pw auth, so `GRAFANA_INBOUND_CIDRS` must be a narrow allow
list (the script rejects `0.0.0.0/0`).

```bash
# 1. Request an ACM cert for the host and DNS-validate it in Route 53 first.
GRAFANA_INGRESS_HOST=grafana.example.com \
GRAFANA_CERT_ARN=arn:aws:acm:ap-northeast-2:<acct>:certificate/<id> \
GRAFANA_INBOUND_CIDRS=<your-ip>/32 \
  scripts/deploy-observability-incluster.sh
# 2. Point a Route 53 A-record (alias) at the created ALB (aws-osmo-grafana).
```

Validated deployment used `https://grafana.yeonkp.xyz` restricted to a single
operator IP.

## Dashboards (persistent)

Dashboards are provisioned as ConfigMaps labelled `grafana_dashboard=1` from
`scripts/observability-dashboards/`, so the Grafana sidecar loads them and they
**survive pod restarts** (API-imported dashboards do not persist). Included:

- `isaac-training-gpu.json` — GPU util/memory (DCGM) + Isaac Lab training
  scalars (`isaac_*` from the Pushgateway) in one view.
- `nvidia-dcgm.json` — standard NVIDIA DCGM exporter dashboard.

Prometheus is auto-wired as the default Grafana data source. Bundled
Kubernetes/node dashboards also load automatically.

## Training metrics -> Grafana (instead of TensorBoard UI)

TensorBoard's web UI cannot be embedded in Grafana. Instead, workflows push
their final scalars (reward, tracking error, loss) to the Pushgateway as
Prometheus gauges named `isaac_*`, so they appear in Grafana next to GPU metrics.

The Isaac Lab example does this in
[examples/isaaclab-rsl-rl-video/workflow-g6.yaml](../examples/isaaclab-rsl-rl-video/workflow-g6.yaml):
after `export_tensorboard_scalars.py`, it reads `metrics-summary.json` and
pushes each scalar's last value to:

```
{{ pushgateway_url }}/metrics/job/isaaclab_rsl_rl/task/<task>
```

`pushgateway_url` default:
`http://aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091`
(set to empty string to disable). The push is best-effort and never fails the run.

Verified metrics after an Isaac Lab run:
- `isaac_metrics_ee_pose_orientation_error{task="Isaac-Reach-Franka-v0"}`
- `isaac_train_mean_episode_length`
- `isaac_loss_value_function`, `isaac_train_mean_reward`, etc.

Query these in Grafana/Prometheus alongside `DCGM_FI_DEV_GPU_UTIL` for a single
GPU + training dashboard.

## Full TensorBoard UI (optional)

If you need the actual TensorBoard interface (histograms, full scalar explorer),
it is not replaced by this path. Download the artifact and run locally:

```bash
osmo dataset download aws-osmo/aws-isaaclab-rsl-rl-video-g6-artifacts:latest ./out
tensorboard --logdir ./out/aws-isaaclab-rsl-rl-video-g6-artifacts/artifacts/tensorboard
# -> http://localhost:6006
```

## Notes

- This is a repo addition on top of the upstream AMG path; the AMP+AMG
  `infra/observability` module is left unchanged.
- Grafana is ClusterIP + port-forward by default. To expose via HTTPS, reuse the
  ALB+ACM pattern from `infra/ingress` (e.g. `grafana.<domain>`), but the
  in-cluster Grafana login is weaker than SSO — prefer port-forward.
- DCGM exporter is installed by the GPU Operator (`scripts/deploy-gpu-operator.sh`);
  this path only adds the ServiceMonitor to scrape it.
