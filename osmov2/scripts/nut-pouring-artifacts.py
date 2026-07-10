import csv
import json
import math
import statistics
import sys
from pathlib import Path


def numeric_values(rows, key):
    return [float(row[key]) for row in rows if not math.isnan(float(row[key]))]


def write_gpu_artifacts(csv_path, out_dir):
    gpu_dir = out_dir / "gpu-metrics"
    gpu_dir.mkdir(parents=True, exist_ok=True)
    fields = [
        "timestamp",
        "index",
        "name",
        "gpu_util_percent",
        "memory_util_percent",
        "memory_used_mib",
        "memory_total_mib",
        "power_draw_w",
        "temperature_c",
    ]

    rows = []
    if csv_path.exists():
        with csv_path.open(newline="") as f:
            for row in csv.reader(f):
                if len(row) != len(fields):
                    continue
                item = {key: value.strip() for key, value in zip(fields, row)}
                for key in fields[3:]:
                    try:
                        item[key] = float(item[key])
                    except ValueError:
                        item[key] = math.nan
                rows.append(item)

    summary = {
        "sample_count": len(rows),
        "gpu_name": rows[0]["name"] if rows else None,
        "gpu_util_percent_avg": statistics.fmean(numeric_values(rows, "gpu_util_percent"))
        if numeric_values(rows, "gpu_util_percent")
        else None,
        "gpu_util_percent_max": max(numeric_values(rows, "gpu_util_percent"))
        if numeric_values(rows, "gpu_util_percent")
        else None,
        "memory_used_mib_avg": statistics.fmean(numeric_values(rows, "memory_used_mib"))
        if numeric_values(rows, "memory_used_mib")
        else None,
        "memory_used_mib_max": max(numeric_values(rows, "memory_used_mib"))
        if numeric_values(rows, "memory_used_mib")
        else None,
        "power_draw_w_avg": statistics.fmean(numeric_values(rows, "power_draw_w"))
        if numeric_values(rows, "power_draw_w")
        else None,
        "power_draw_w_max": max(numeric_values(rows, "power_draw_w"))
        if numeric_values(rows, "power_draw_w")
        else None,
    }
    (gpu_dir / "gpu-metrics-summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        x = list(range(len(rows)))
        fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
        axes[0].plot(x, numeric_values(rows, "gpu_util_percent"), label="GPU util %", color="#2563eb")
        axes[0].plot(x, numeric_values(rows, "memory_util_percent"), label="Memory util %", color="#16a34a")
        axes[0].set_ylabel("percent")
        axes[0].legend(loc="upper right")
        axes[0].grid(True, alpha=0.3)

        axes[1].plot(
            x,
            [value / 1024 for value in numeric_values(rows, "memory_used_mib")],
            label="Memory used GiB",
            color="#9333ea",
        )
        axes[1].set_ylabel("GiB")
        axes[1].legend(loc="upper right")
        axes[1].grid(True, alpha=0.3)

        axes[2].plot(x, numeric_values(rows, "power_draw_w"), label="Power W", color="#ea580c")
        axes[2].plot(x, numeric_values(rows, "temperature_c"), label="Temp C", color="#dc2626")
        axes[2].set_xlabel("sample")
        axes[2].set_ylabel("W / C")
        axes[2].legend(loc="upper right")
        axes[2].grid(True, alpha=0.3)

        fig.suptitle("Nut pouring GR00T GPU utilization")
        fig.tight_layout()
        fig.savefig(gpu_dir / "gpu-utilization.png", dpi=150)
    except Exception as exc:
        (gpu_dir / "gpu-metrics-plot-error.txt").write_text(str(exc) + "\n")


def write_loss_artifacts(out_dir):
    try:
        from tensorboard.backend.event_processing import event_accumulator

        loss_rows = []
        for event_file in sorted(out_dir.rglob("events.out.tfevents.*")):
            accumulator = event_accumulator.EventAccumulator(
                str(event_file),
                size_guidance={event_accumulator.SCALARS: 0},
            )
            accumulator.Reload()
            for tag in accumulator.Tags().get("scalars", []):
                if "loss" not in tag.lower():
                    continue
                for event in accumulator.Scalars(tag):
                    loss_rows.append(
                        {
                            "tag": tag,
                            "step": event.step,
                            "wall_time": event.wall_time,
                            "value": event.value,
                        }
                    )

        loss_rows.sort(key=lambda row: (row["tag"], row["step"]))
        if not loss_rows:
            return

        with (out_dir / "train-loss.csv").open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["tag", "step", "wall_time", "value"])
            writer.writeheader()
            writer.writerows(loss_rows)

        first_tag = loss_rows[0]["tag"]
        series = [row for row in loss_rows if row["tag"] == first_tag]

        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(10, 5))
        ax.plot([row["step"] for row in series], [row["value"] for row in series], color="#2563eb")
        ax.set_title(f"Nut pouring GR00T training loss: {first_tag}")
        ax.set_xlabel("step")
        ax.set_ylabel("loss")
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        fig.savefig(out_dir / "train-loss.png", dpi=150)

        summary = {
            "tag": first_tag,
            "points": len(series),
            "first_step": series[0]["step"],
            "first_value": series[0]["value"],
            "last_step": series[-1]["step"],
            "last_value": series[-1]["value"],
            "min_value": min(row["value"] for row in series),
            "max_value": max(row["value"] for row in series),
        }
        (out_dir / "train-loss-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    except Exception as exc:
        (out_dir / "train-loss-plot-error.txt").write_text(str(exc) + "\n")


def main():
    csv_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    write_gpu_artifacts(csv_path, out_dir)
    write_loss_artifacts(out_dir)


if __name__ == "__main__":
    main()
