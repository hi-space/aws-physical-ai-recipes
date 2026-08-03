# Canonical training-metrics pusher for OSMO GPU workflows.
#
# OSMO workflows embed files inline (files: contents:), so there is no host
# include mechanism — copy this whole file into a workflow's files: block (see
# docs/adding-workflow-metrics.md) instead of referencing it at runtime.
#
# What it does: reads a training process's stdout on stdin, echoes every line
# back unchanged (so `osmo workflow logs` still shows the full stream), and
# scrapes HF-Trainer-style scalar dicts — e.g. {'loss': 0.7, 'grad_norm': 2.6,
# 'learning_rate': 3e-06, 'epoch': 0.1} — pushing them to a Prometheus
# Pushgateway as gauges. It uses only the stdlib so it runs under the system
# python3 without touching the training venv.
#
# Contract:
# - No-op pure tee when PUSHGATEWAY_URL is empty (e.g. no in-cluster
#   observability), so the same workflow runs unchanged on the AMP+AMG path.
# - Every push is wrapped: a metrics failure can never break training.
#
# Env knobs (all optional except where noted):
#   PUSHGATEWAY_URL   Pushgateway base, e.g.
#                     http://aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091
#                     Empty => pure tee.
#   METRICS_JOB       Prometheus job label (default "training"). One per pipeline
#                     stage, e.g. "groot_training", so panels can filter by job.
#   METRICS_PREFIX    Metric-name prefix (default "train"). Produces
#                     <prefix>_loss, <prefix>_learning_rate, <prefix>_grad_norm,
#                     <prefix>_epoch, <prefix>_global_step.
#   WORKFLOW_ID       Value for the {workflow=...} label (default "unknown").
#                     Set to ${HOSTNAME} so each run is a distinct series.
#
# Usage in a workflow (pipe training stdout through it; set -o pipefail keeps
# the trainer's exit status):
#   uv run python train.py ... 2>&1 \
#     | PUSHGATEWAY_URL="${PUSHGATEWAY_URL}" METRICS_JOB="groot_training" \
#       METRICS_PREFIX="groot_train" WORKFLOW_ID="${HOSTNAME}" \
#       python3 -u /tmp/push_metrics.py
import ast
import os
import re
import sys
import urllib.request

PGW = os.environ.get("PUSHGATEWAY_URL", "").rstrip("/")
JOB = os.environ.get("METRICS_JOB", "training")
PREFIX = re.sub(r"[^A-Za-z0-9_]+", "_", os.environ.get("METRICS_PREFIX", "train")).strip("_") or "train"
WF = os.environ.get("WORKFLOW_ID", "unknown")

# Match the first {...} dict on a line that mentions 'loss'. HF Trainer prints
# these once per logging_steps; other trainers that print the same dict shape
# work unchanged.
LOSS_RE = re.compile(r"(\{[^{}]*'loss'[^{}]*\})")

# HF Trainer scalar key -> metric suffix. Add rows here to capture more scalars.
KEY_MAP = (
    ("loss", "loss"),
    ("learning_rate", "learning_rate"),
    ("epoch", "epoch"),
    ("grad_norm", "grad_norm"),
)


def push(step, d):
    if not PGW:
        return
    lines = []
    for key, suffix in KEY_MAP:
        if key in d:
            try:
                lines.append("{}_{} {}".format(PREFIX, suffix, float(d[key])))
            except (TypeError, ValueError):
                pass
    lines.append("{}_global_step {}".format(PREFIX, step))
    body = ("\n".join(lines) + "\n").encode()
    url = "{}/metrics/job/{}/workflow/{}".format(PGW, JOB, WF)
    try:
        req = urllib.request.Request(url, data=body, method="POST")
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as exc:  # noqa: BLE001 - metrics must never break training
        sys.stderr.write("push_metrics: {}\n".format(exc))


def main():
    step = 0
    for line in sys.stdin:
        sys.stdout.write(line)
        sys.stdout.flush()
        m = LOSS_RE.search(line)
        if not m:
            continue
        try:
            d = ast.literal_eval(m.group(1))
        except (ValueError, SyntaxError):
            continue
        if "loss" not in d:
            continue
        step += 1
        push(step, d)


if __name__ == "__main__":
    main()
