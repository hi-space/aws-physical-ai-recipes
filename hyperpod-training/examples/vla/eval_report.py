"""Aggregate per-trial eval records into a structured report.

Takes trial-level records and produces eval-report.json plus a console
breakdown. Three input sources:

  --trials            JSONL, one record per attempt (real-robot or any harness)
  --rollout-log       a leisaac policy_inference.py log, parsed for "[N/M]"
  --openloop-results  eval_results.json from eval_closed_loop.py (action MSE)

The first two measure task success, so the report carries
`metric: success_rate`. Open-loop results measure behaviour-cloning fidelity
instead, so they carry `metric: openloop_mse` and no success rate at all.
gate_checkpoint.py refuses to promote on that metric — it can only block.
Open-loop MSE is the cheap first filter before a closed-loop rollout, not the
promotion signal.

The report keeps per-part and per-scenario breakdowns because aggregate
success rate hides the actionable signal: a part that fails every single
attempt is a different problem from one that fails intermittently.

Reports a Wilson 95% interval per checkpoint and, when two checkpoints are
present, the per-arm sample size needed to distinguish their rates. Small-n
comparisons are flagged as indistinguishable so a gate does not act on noise.

Usage:
  python eval_report.py --trials eval_trials/real_pick_2026-10-22.jsonl
  python eval_report.py --rollout-log /fsx/scratch/logs/closed-loop-1234.out
  python eval_report.py --openloop-results /fsx/checkpoints/rl/openloop-eval-x/eval_results.json
  python eval_report.py --trials trials.jsonl --out /fsx/scratch/eval-report.json
"""

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

Z_95 = 1.959964
Z_POWER_80 = 0.841621


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate VLA eval trials into a report")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--trials", type=Path, help="JSONL of per-trial records")
    source.add_argument("--rollout-log", type=Path, help="leisaac rollout log to parse")
    source.add_argument("--openloop-results", type=Path,
                        help="eval_results.json from eval_closed_loop.py (action MSE)")
    parser.add_argument("--checkpoint-name", type=str, default=None,
                        help="Checkpoint label for --rollout-log / --openloop-results input")
    parser.add_argument("--out", type=Path, default=None,
                        help="Write eval-report.json here (default: alongside input)")
    return parser.parse_args()


def load_trials(path):
    """Read JSONL trial records, failing loudly on malformed input."""
    records = []
    with path.open() as handle:
        for lineno, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: invalid JSON: {exc}")
            missing = {"checkpoint", "success"} - record.keys()
            if missing:
                raise SystemExit(f"{path}:{lineno}: missing required field(s): {sorted(missing)}")
            records.append(record)
    if not records:
        raise SystemExit(f"{path}: no trial records found")
    return records


def load_rollout_log(path, checkpoint_name):
    """Expand a leisaac '[N/M]' summary into M synthetic trial records.

    leisaac reports only aggregate counts, so per-part detail is unavailable
    here. The expansion keeps the downstream aggregation path identical for
    both input sources.
    """
    text = path.read_text(errors="replace")
    counts = re.findall(r"success rate:\s*[\d.]+\s*\[(\d+)/(\d+)\]", text)
    if not counts:
        raise SystemExit(f"{path}: no 'success rate: ... [N/M]' line found")
    successes, total = int(counts[-1][0]), int(counts[-1][1])
    label = checkpoint_name or path.stem
    return [
        {
            "checkpoint": label,
            "part": "unknown",
            "scenario": "sim_rollout",
            "trial": i + 1,
            "success": i < successes,
            "source": "leisaac_log",
        }
        for i in range(total)
    ]


def load_openloop_results(path, checkpoint_name):
    """Summarize eval_closed_loop.py's eval_results.json by action MSE.

    There is no success/failure here — only how far each predicted action was
    from the recorded one. So this returns a summary directly instead of
    synthetic trial records: faking a pass/fail per episode would invent a
    success signal that the open-loop run never measured.
    """
    payload = json.loads(path.read_text())
    episodes = payload.get("results") or []
    if not episodes:
        raise SystemExit(f"{path}: no 'results' entries found")

    mses = [float(e["mse"]) for e in episodes]
    label = checkpoint_name or payload.get("args", {}).get("model_path") or path.stem
    return {
        "checkpoint_name": str(label),
        "summary": {
            "episodes": len(mses),
            "mse_mean": round(sum(mses) / len(mses), 6),
            "mse_max": round(max(mses), 6),
        },
        "sources": ["openloop_mse"],
        "per_episode": {str(e["episode"]): round(float(e["mse"]), 6) for e in episodes},
    }


def wilson_interval(successes, total):
    """Wilson score interval — holds up at small n and p near 0, unlike normal approx."""
    if total == 0:
        return (0.0, 0.0)
    p = successes / total
    denom = 1 + Z_95**2 / total
    center = (p + Z_95**2 / (2 * total)) / denom
    margin = Z_95 * math.sqrt(p * (1 - p) / total + Z_95**2 / (4 * total**2)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def required_n_per_arm(p1, p2):
    """Trials per arm for 80% power at alpha=0.05 on a two-proportion test."""
    delta = abs(p1 - p2)
    if delta == 0:
        return None
    variance = p1 * (1 - p1) + p2 * (1 - p2)
    return math.ceil((Z_95 + Z_POWER_80) ** 2 * variance / delta**2)


def group_by(trials, key):
    grouped = defaultdict(list)
    for trial in trials:
        grouped[trial.get(key, "unknown")].append(trial)
    return grouped


def tally(trials):
    hits = sum(1 for t in trials if t["success"])
    return {
        "successful_trials": hits,
        "total_rollouts": len(trials),
        "success_rate": hits / len(trials),
    }


def summarize(records):
    summaries = []
    for name, trials in group_by(records, "checkpoint").items():
        # per_part only covers single-part scenarios: a multi-part sequential
        # attempt has no single "part" to attribute its failure to, so mixing
        # it in would report the whole sequence as a failing part.
        single_part = [t for t in trials if t.get("scenario") != "random_sequential"]
        stats = tally(trials)
        low, high = wilson_interval(stats["successful_trials"], stats["total_rollouts"])
        summaries.append({
            "checkpoint_name": name,
            "summary": stats,
            "wilson_ci_95": [round(low, 4), round(high, 4)],
            "sources": sorted({t.get("source", "unknown") for t in trials}),
            "per_part": {p: tally(ts) for p, ts in group_by(single_part, "part").items()},
            "per_scenario": {s: tally(ts) for s, ts in group_by(trials, "scenario").items()},
        })

    summaries.sort(key=lambda s: s["summary"]["success_rate"], reverse=True)
    return summaries


def compare(summaries):
    """Flag whether the top two checkpoints are statistically separable."""
    if len(summaries) < 2:
        return None
    best, second = summaries[0], summaries[1]
    p1 = best["summary"]["success_rate"]
    p2 = second["summary"]["success_rate"]
    needed = required_n_per_arm(p1, p2)
    smallest_arm = min(best["summary"]["total_rollouts"], second["summary"]["total_rollouts"])
    ci_overlap = best["wilson_ci_95"][0] <= second["wilson_ci_95"][1]
    return {
        "checkpoints": [best["checkpoint_name"], second["checkpoint_name"]],
        "success_rates": [p1, p2],
        "required_n_per_arm": needed,
        "actual_n_per_arm": smallest_arm,
        "ci_overlap": ci_overlap,
        "distinguishable": bool(needed and smallest_arm >= needed and not ci_overlap),
    }


def find_systematic_failures(summaries):
    """Parts that failed every attempt on every checkpoint.

    A shared total failure implicates the part or the grasp pose rather than
    one model, so it drives data collection instead of checkpoint selection.
    """
    if not summaries:
        return []
    zero_sets = [
        {part for part, stats in summary["per_part"].items()
         if stats["successful_trials"] == 0 and part != "unknown"}
        for summary in summaries
    ]
    return sorted(set.intersection(*zero_sets))


def print_openloop_report(report):
    print("=" * 62)
    print("VLA eval report — open-loop MSE")
    print("=" * 62)
    for summary in report["checkpoints"]:
        stats = summary["summary"]
        print(f"\n  {summary['checkpoint_name']}")
        print(f"    episodes: {stats['episodes']}")
        print(f"    mse mean: {stats['mse_mean']:.6f}   max: {stats['mse_max']:.6f}")
    print("\n  Open-loop MSE is behaviour-cloning fidelity, not task success.")
    print("  This report can block a bad checkpoint but cannot promote one;")
    print("  a closed-loop or real-robot success rate is required for that.")
    print()


def print_report(report):
    if report["metric"] == "openloop_mse":
        print_openloop_report(report)
        return

    print("=" * 62)
    print("VLA eval report")
    print("=" * 62)

    for summary in report["checkpoints"]:
        stats = summary["summary"]
        low, high = summary["wilson_ci_95"]
        print(f"\n  {summary['checkpoint_name']}")
        print(f"    success: {stats['successful_trials']}/{stats['total_rollouts']}"
              f" = {stats['success_rate']:.0%}"
              f"   95% CI [{low:.0%}, {high:.0%}]")
        print(f"    source:  {', '.join(summary['sources'])}")

        for scenario, sstats in sorted(summary["per_scenario"].items()):
            print(f"    {scenario}: {sstats['successful_trials']}/{sstats['total_rollouts']}"
                  f" = {sstats['success_rate']:.0%}")

        zero_parts = [p for p, s in sorted(summary["per_part"].items())
                      if s["successful_trials"] == 0 and p != "unknown"]
        if zero_parts:
            print(f"    zero-success parts: {', '.join(zero_parts)}")

    systematic = report["systematic_failures"]
    if systematic:
        print(f"\n  SYSTEMATIC: {', '.join(systematic)} failed every attempt on"
              " every checkpoint.")
        print("    Implicates the part/grasp pose, not the checkpoint — this is a")
        print("    data-collection target, not a model-selection signal.")

    comparison = report["comparison"]
    if comparison:
        p1, p2 = comparison["success_rates"]
        print(f"\n  comparison: {p1:.0%} vs {p2:.0%}"
              f"  (n={comparison['actual_n_per_arm']} per arm)")
        if comparison["distinguishable"]:
            print("    distinguishable at 95% confidence.")
        else:
            print(f"    NOT distinguishable — needs ~{comparison['required_n_per_arm']}"
                  " trials per arm for 80% power.")
            print("    Do not gate on this gap; it is within noise.")

    print()


def main():
    args = parse_args()

    if args.openloop_results:
        summary = load_openloop_results(args.openloop_results, args.checkpoint_name)
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": str(args.openloop_results),
            "metric": "openloop_mse",
            "total_trials": summary["summary"]["episodes"],
            "checkpoints": [summary],
            "systematic_failures": [],
            "comparison": None,
        }
        source_path = args.openloop_results
    else:
        if args.trials:
            records = load_trials(args.trials)
            source_path = args.trials
        else:
            records = load_rollout_log(args.rollout_log, args.checkpoint_name)
            source_path = args.rollout_log

        summaries = summarize(records)
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": str(source_path),
            "metric": "success_rate",
            "total_trials": len(records),
            "checkpoints": summaries,
            "systematic_failures": find_systematic_failures(summaries),
            "comparison": compare(summaries),
        }

    out_path = args.out or source_path.parent / "eval-report.json"
    out_path.write_text(json.dumps(report, indent=2) + "\n")

    print_report(report)
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
