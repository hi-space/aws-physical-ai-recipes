"""Decide whether an evaluated checkpoint may be promoted.

Reads the eval-report.json produced by eval_report.py, applies a success-rate
threshold, and exits non-zero on BLOCK so a dependent job (deploy, edge
rollout) never runs on a checkpoint that failed evaluation. Slurm holds that
job back with --dependency=afterok; Argo Workflows with `depends`. This is
the step that closes the development loop: without it, eval results are
written and never read.

Beyond the threshold, two conditions also block:

  --require-distinguishable  refuses to promote when the margin over the
      runner-up is within noise. Prevents small-n noise from picking a winner.
  --max-systematic-failures  refuses to promote when too many parts fail
      every single attempt, even if the aggregate rate clears the bar.

Logs eval_success_rate and gate_promoted to MLflow when MLFLOW_TRACKING_URI
is set, so eval metrics land on the same tracking server as training runs.

With --promote-alias, a PROMOTE also moves a Model Registry alias onto the
version whose `fsx_dir` tag matches the gated checkpoint. That tag is written
by register_groot_model.py, which deliberately leaves promotion to a human —
this flag automates that last step, and only ever on a measured success rate.

Two metrics, two powers. A report built from task success
(`metric: success_rate`) can promote. A report built from open-loop action
MSE (`metric: openloop_mse`) can only block: it measures behaviour-cloning
fidelity, not whether the task succeeded, so a clean MSE yields PASS rather
than PROMOTE and never touches an alias. Chain it as the cheap first filter
ahead of a closed-loop rollout.

Usage:
  python gate_checkpoint.py --report eval_trials/eval-report.json --threshold 0.5
  python gate_checkpoint.py --report r.json --threshold 0.5 --require-distinguishable
  python gate_checkpoint.py --report r.json --threshold 0.5 \
      --promote-alias champion --model-name groot-so101-place-orange
  python gate_checkpoint.py --report openloop.json --max-mse 0.05
"""

import argparse
import json
import os
import sys
from pathlib import Path

# The gate runs on a bare python image with no git checkout. Without this,
# mlflow prints three multi-line tracebacks while probing for a source commit,
# which buries the PASS/BLOCK banner in the Job log.
os.environ.setdefault("GIT_PYTHON_REFRESH", "quiet")


def parse_args():
    parser = argparse.ArgumentParser(description="Gate a checkpoint on eval results")
    parser.add_argument("--report", type=Path, required=True,
                        help="eval-report.json from eval_report.py")
    parser.add_argument("--threshold", type=float, default=0.5,
                        help="Minimum success rate to promote (default: 0.5)")
    parser.add_argument("--checkpoint-name", type=str, default=None,
                        help="Which checkpoint to gate (default: best in report)")
    parser.add_argument("--require-distinguishable", action="store_true",
                        help="Block if the margin over the runner-up is within noise")
    parser.add_argument("--max-systematic-failures", type=int, default=None,
                        help="Block if more than N parts fail every attempt")
    parser.add_argument("--max-mse", type=float, default=None,
                        help="Block if mean open-loop MSE exceeds this (openloop_mse reports)")
    parser.add_argument("--promote-alias", type=str, default=None,
                        help="On PROMOTE, move this Model Registry alias onto the version")
    parser.add_argument("--model-name", type=str, default=None,
                        help="Registered model name for --promote-alias")
    parser.add_argument("--checkpoint-dir", type=str, default=None,
                        help="FSx checkpoint dir, matched against each version's fsx_dir tag")
    parser.add_argument("--experiment", type=str, default="physical-ai-vla",
                        help="MLflow experiment name")
    parser.add_argument("--out", type=Path, default=None,
                        help="Write gate-decision.json here (default: alongside report)")
    return parser.parse_args()


def select_checkpoint(report, name):
    candidates = report["checkpoints"]
    if not candidates:
        raise SystemExit("report has no checkpoints")
    if name is None:
        return candidates[0]
    for candidate in candidates:
        if candidate["checkpoint_name"] == name:
            return candidate
    available = [c["checkpoint_name"] for c in candidates]
    raise SystemExit(f"checkpoint '{name}' not in report. Available: {available}")


def evaluate_gate(report, target, args):
    """Collect every blocking reason rather than short-circuiting on the first.

    Seeing all failures at once avoids a retry loop where each run surfaces
    only the next problem.
    """
    reasons = []

    # An open-loop report has no success rate, so the success-rate conditions
    # do not apply — only the MSE ceiling does.
    if report.get("metric") == "openloop_mse":
        mse = target["summary"]["mse_mean"]
        if args.max_mse is not None and mse > args.max_mse:
            reasons.append(
                f"mean open-loop MSE {mse:.6f} exceeds limit {args.max_mse:.6f}"
                f" ({target['summary']['episodes']} episodes)"
            )
        return reasons

    rate = target["summary"]["success_rate"]

    if rate < args.threshold:
        reasons.append(
            f"success_rate {rate:.0%} below threshold {args.threshold:.0%}"
            f" ({target['summary']['successful_trials']}"
            f"/{target['summary']['total_rollouts']} trials)"
        )

    comparison = report.get("comparison")
    if args.require_distinguishable and comparison and not comparison["distinguishable"]:
        reasons.append(
            "margin over runner-up is within noise"
            f" (n={comparison['actual_n_per_arm']} per arm,"
            f" needs ~{comparison['required_n_per_arm']})"
        )

    systematic = report.get("systematic_failures", [])
    if args.max_systematic_failures is not None \
            and len(systematic) > args.max_systematic_failures:
        reasons.append(
            f"{len(systematic)} parts fail every attempt"
            f" (limit {args.max_systematic_failures}): {', '.join(systematic)}"
        )

    return reasons


def promote_alias(decision, model_name, alias, checkpoint_dir):
    """Move a Model Registry alias onto the version holding this checkpoint.

    Versions are matched on the `fsx_dir` tag that register_groot_model.py
    writes, because the gate knows a checkpoint path while the registry is
    keyed by version number. Searching newest-first means a re-registered
    checkpoint promotes its most recent version.

    A failure here is a warning, not an error: the gate decision itself is
    already written and must not be retracted because the registry was
    unreachable.
    """
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        print("[promote] MLFLOW_TRACKING_URI not set. Skipping alias promotion.")
        return None
    if not checkpoint_dir:
        print("[promote] no --checkpoint-dir given, cannot match a model version."
              " Skipping alias promotion.")
        return None

    try:
        from mlflow import MlflowClient
        client = MlflowClient()

        target = str(checkpoint_dir).rstrip("/")
        match = None
        for version in client.search_model_versions(f"name='{model_name}'"):
            if (version.tags or {}).get("fsx_dir", "").rstrip("/") == target:
                if match is None or int(version.version) > int(match.version):
                    match = version

        if match is None:
            print(f"[promote] no version of '{model_name}' has fsx_dir={target}."
                  " Register the checkpoint first (register_groot_model.py).")
            return None

        client.set_registered_model_alias(model_name, alias, match.version)
        print(f"[promote] alias '{alias}' -> {model_name} version {match.version}")
        return {"model_name": model_name, "alias": alias, "version": match.version}
    except Exception as exc:
        print(f"[WARN] alias promotion failed: {exc}. The gate decision stands.")
        return None


def log_to_mlflow(decision, experiment):
    """Attach eval metrics to the tracking server used by train_groot/train_pi0."""
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        print("[MLflow] MLFLOW_TRACKING_URI not set. Skipping MLflow logging.")
        return

    try:
        import mlflow
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment(experiment)
        # Checkpoints arrive as /fsx paths long enough that the MLflow run list
        # truncates them to the common prefix. The full path stays in the params.
        short = os.path.basename(decision["checkpoint"].rstrip("/"))
        with mlflow.start_run(run_name=f"gate-{short}"):
            params = {
                "checkpoint": decision["checkpoint"],
                "gate_metric": decision["metric"],
                "gate_decision": decision["decision"],
                "threshold": decision.get("threshold", decision.get("max_mse")),
            }
            # Without the reasons, a dashboard row says BLOCK but not why, and
            # the only copy of that is the Job log, which the TTL deletes.
            if decision["reasons"]:
                params["gate_reasons"] = "; ".join(decision["reasons"])[:500]
            promoted = decision.get("promoted_alias")
            if promoted:
                params["promoted_alias"] = promoted["alias"]
                params["promoted_version"] = promoted["version"]
            mlflow.log_params(params)
            metrics = {"gate_promoted": 1 if decision["decision"] == "PROMOTE" else 0}
            if decision["metric"] == "success_rate":
                metrics["eval_success_rate"] = decision["success_rate"]
                metrics["eval_total_trials"] = decision["total_rollouts"]
            else:
                metrics["eval_openloop_mse"] = decision["mse_mean"]
                metrics["eval_episodes"] = decision["episodes"]
            mlflow.log_metrics(metrics)
        print(f"[MLflow] Logged gate decision to experiment '{experiment}'.")
    except Exception as exc:
        print(f"[MLflow] Failed to log: {exc}")


def main():
    args = parse_args()

    report = json.loads(args.report.read_text())
    metric = report.get("metric", "success_rate")
    target = select_checkpoint(report, args.checkpoint_name)
    reasons = evaluate_gate(report, target, args)

    # PASS, not PROMOTE: clearing an MSE ceiling says the checkpoint is worth
    # a closed-loop rollout, not that it may be released.
    if reasons:
        label = "BLOCK"
    else:
        label = "PROMOTE" if metric == "success_rate" else "PASS"

    decision = {
        "decision": label,
        "metric": metric,
        "checkpoint": target["checkpoint_name"],
        "reasons": reasons,
        "report": str(args.report),
    }
    if metric == "success_rate":
        decision.update({
            "success_rate": target["summary"]["success_rate"],
            "total_rollouts": target["summary"]["total_rollouts"],
            "wilson_ci_95": target["wilson_ci_95"],
            "threshold": args.threshold,
        })
    else:
        decision.update({
            "mse_mean": target["summary"]["mse_mean"],
            "episodes": target["summary"]["episodes"],
            "max_mse": args.max_mse,
        })

    print("=" * 62)
    print(f"Gate: {label}")
    print("=" * 62)
    print(f"  checkpoint:   {decision['checkpoint']}")
    if metric == "success_rate":
        print(f"  success_rate: {decision['success_rate']:.0%}"
              f" ({target['summary']['successful_trials']}/{decision['total_rollouts']})")
        print(f"  threshold:    {decision['threshold']:.0%}")
    else:
        print(f"  mse_mean:     {decision['mse_mean']:.6f}"
              f" ({decision['episodes']} episodes)")
        if args.max_mse is not None:
            print(f"  max_mse:      {args.max_mse:.6f}")
    for reason in reasons:
        print(f"  BLOCKED: {reason}")
    if not reasons:
        print("  All gate conditions passed.")
    print()

    if label == "PROMOTE" and args.promote_alias:
        if not args.model_name:
            print("[promote] --promote-alias needs --model-name. Skipping.")
        else:
            promoted = promote_alias(decision, args.model_name,
                                     args.promote_alias, args.checkpoint_dir)
            decision["promoted_alias"] = promoted

    log_to_mlflow(decision, args.experiment)

    out_path = args.out or args.report.parent / "gate-decision.json"
    out_path.write_text(json.dumps(decision, indent=2) + "\n")
    print(f"Wrote {out_path}")

    # Non-zero exit is the whole point: Slurm's afterok dependency and Argo's
    # `depends` both hold back the downstream job when the gate blocks.
    return 1 if reasons else 0


if __name__ == "__main__":
    sys.exit(main())
