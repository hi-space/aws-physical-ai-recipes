# Adding per-pipeline metrics to Grafana

GPU workflows already get DCGM GPU metrics (util/VRAM/power/temp) in the
`AWS OSMO Overview` Grafana dashboard automatically. This guide is for pushing
*your own* training scalars — loss, learning rate, epoch, reward, etc. — into
the same Grafana, so a run's training curves sit next to its GPU curves.

Korean: [adding-workflow-metrics.ko.md](adding-workflow-metrics.ko.md).

## Why a Pushgateway (and not scrape / MLflow)

Training jobs are ephemeral pods that Prometheus can't reliably scrape, and HF
Trainer only prints scalars to stdout. So workflows *push* scalars to an
in-cluster Prometheus Pushgateway; Prometheus scrapes the gateway and
remote-writes to AMP, and Grafana reads AMP. This replaces the old MLflow /
TensorBoard-UI habit — the numbers land as Prometheus gauges you can query and
panel like any other metric.

The Pushgateway is deployed by both observability scripts:
- `scripts/deploy-observability.sh` (AMP + AMG path)
- `scripts/deploy-observability-incluster.sh` (self-hosted Prometheus/Grafana)

Canonical service (from `versions.yaml`):
`aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091`

## The two push patterns in this repo

| Pattern | When to use | Reference |
| --- | --- | --- |
| stdout parse (tee) | trainer prints scalar dicts to stdout (HF Trainer) | `e2e-pipeline-examples/03-training/workflow.yaml` |
| file export | metrics only exist as files (TensorBoard event files) | `examples/isaaclab-rsl-rl-video/workflow-g6.yaml` |

Most GR00T / HF-Trainer stages use the stdout pattern below. For TensorBoard
event files, see the Isaac Lab example (it runs `export_tensorboard_scalars.py`
then curls the last value of each scalar to the gateway).

## Quick start (stdout pattern)

OSMO workflows embed files inline (`files: contents:`) — there is no host
include, so you copy the pusher into each workflow. The canonical copy-source is
[`scripts/push_metrics.py`](../scripts/push_metrics.py); it is stdlib-only,
prefix-configurable, and a no-op tee when `PUSHGATEWAY_URL` is empty.

1. Add the file to your workflow's `files:` block by pasting the contents of
   `scripts/push_metrics.py`:

   ```yaml
   files:
   - path: /tmp/push_metrics.py
     contents: |
       # <paste scripts/push_metrics.py here, indented under contents:>
   ```

2. Set the env knobs near the top of your task script:

   ```bash
   PUSHGATEWAY_URL="{{ pushgateway_url }}"   # empty => pure tee, no push
   METRICS_JOB="my_stage_training"           # Prometheus job label (one per stage)
   METRICS_PREFIX="my_stage"                 # => my_stage_loss, my_stage_epoch, ...
   WORKFLOW_ID="${HOSTNAME}"                 # {workflow=...} label; one series per run
   ```

3. Pipe your trainer's stdout through it. `set -o pipefail` (already on in the
   e2e stages) keeps the trainer's exit status:

   ```bash
   uv run python train.py ... 2>&1 \
     | PUSHGATEWAY_URL="${PUSHGATEWAY_URL}" METRICS_JOB="${METRICS_JOB}" \
       METRICS_PREFIX="${METRICS_PREFIX}" WORKFLOW_ID="${WORKFLOW_ID}" \
       python3 -u /tmp/push_metrics.py
   ```

4. Add the default to your workflow's `default-values:` so runs on the AMP path
   push, and runs without observability degrade to a plain tee:

   ```yaml
   default-values:
     pushgateway_url: "http://aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091"
   ```

That's it. The pusher scrapes HF-Trainer scalar dicts
(`{'loss': ..., 'learning_rate': ..., 'grad_norm': ..., 'epoch': ...}`) and emits
`<prefix>_loss`, `<prefix>_learning_rate`, `<prefix>_grad_norm`, `<prefix>_epoch`,
and `<prefix>_global_step`, all labelled `{job="<METRICS_JOB>", workflow="<id>"}`.

To capture extra scalar keys, add rows to `KEY_MAP` in `push_metrics.py`.

## Add a Grafana panel

Panels for the GR00T stage live in `scripts/deploy-observability.sh`
(`import_aws_osmo_overview_dashboard`, the "GR00T training scalars" row, panels
id 11–15). To surface a new stage's metrics, add a timeseries panel there with
your metric name, e.g.:

```json
{ "type": "timeseries", "title": "My stage loss",
  "datasource": {"type": "prometheus", "uid": "$datasource_uid"},
  "targets": [{"refId": "A",
    "expr": "my_stage_loss{job=\"my_stage_training\"}",
    "legendFormat": "{{workflow}}"}] }
```

Re-run `scripts/deploy-observability.sh` to re-import the dashboard (it upserts,
so existing panels are preserved/overwritten by uid).

## Verify

While a run is training, confirm the gauge reached AMP. Query AMP directly with
SigV4 (region us-east-1), or just open the `AWS OSMO Overview` dashboard:

```bash
# via Grafana Explore (easiest): expr = my_stage_loss{job="my_stage_training"}
# or query AMP with a SigV4-signed GET to:
#   <amp_prometheus_endpoint>/api/v1/query?query=my_stage_loss
```

For the GR00T stage, verified live values looked like
`groot_train_loss=1.1076`, `groot_learning_rate=3.02e-06`, `groot_grad_norm=2.6554`.

## Gotchas

- Empty `pushgateway_url` = pure tee (no metrics). This is intentional so the
  AMP+AMG path (which is where use1 runs) still needs the Pushgateway deployed —
  `deploy-observability.sh` deploys it, but if you point a stage at a cluster
  without it, set `pushgateway_url=""` to avoid noisy push warnings.
- `epoch` only appears once a full epoch boundary is crossed; short smoke runs
  (`max_steps=10`) will have `<prefix>_loss` but no `<prefix>_epoch`.
- One `METRICS_JOB` per stage keeps panels filterable; reusing the same job
  across stages mixes series under one label.
