/**
 * Python entrypoints shipped to GR00T pipeline tasks through `files:` (ConfigMap).
 * They are plain strings so the workflow YAML stays self-contained and exportable;
 * `{{ ... }}` never appears here because parameters are passed as CLI arguments.
 * Both scripts mirror e2e-workshop/groot/pipeline (smoke_eval.py, train.py export)
 * so the EKS pipeline and the SageMaker pipeline produce the same artefacts.
 */

/** Runs inside the groot-sm-training image on a GPU node: smoke check + open-loop MSE, writes evaluation.json, non-zero exit = gate failed. */
export const GR00T_EVAL_PY = String.raw`#!/usr/bin/env python3
"""GR00T evaluation gate: load the fine-tuned checkpoint, verify get_action() (smoke, same rule as
e2e-workshop/groot/pipeline/smoke_eval.py) and run the upstream open-loop evaluation
(gr00t/eval/open_loop_eval.py) on N dataset trajectories. Writes <output>/evaluation.json and
<output>/plots/traj_<i>.jpeg. Exit 0 = gate passed, 3 = gate failed, 2 = load/inference failure."""
import argparse
import glob
import json
import os
import runpy
import sys
import time
import traceback
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--model-root", required=True, help="finetune task output (training output_dir)")
ap.add_argument("--dataset", required=True, help="LeRobot v2.1 dataset root (with modality_config.py)")
ap.add_argument("--output", required=True)
ap.add_argument("--embodiment-tag", default="NEW_EMBODIMENT")
ap.add_argument("--trajectories", type=int, default=3)
ap.add_argument("--steps", type=int, default=150)
ap.add_argument("--action-horizon", type=int, default=16)
ap.add_argument("--max-mse", type=float, default=0.0, help="gate threshold on mean open-loop MSE; 0 = record only")
ap.add_argument("--language", default="pick the orange")
ap.add_argument("--modality-config", default="", help="python file registering the embodiment modality config; default <dataset>/modality_config.py")
args = ap.parse_args()

out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
report = {"model_path": None, "smoke": {"passed": 0}, "open_loop": {}, "gate": {"passed": 0}, "error": ""}


def finish(code: int) -> None:
    (out / "evaluation.json").write_text(json.dumps(report, indent=2))
    print("EVALUATION REPORT:", json.dumps(report))
    sys.exit(code)


def pick_model_dir(root: str) -> str:
    """Gr00tPolicy needs weights *and* processor files in one directory. launch_finetune writes the
    weights to the output root but keeps the processor under processor/ and copies it into every
    checkpoint-N, so the newest checkpoint is the loadable one (root only works after an export)."""
    ckpts = [p for p in glob.glob(os.path.join(root, "checkpoint-*")) if p.rsplit("-", 1)[-1].isdigit()]
    ckpts.sort(key=lambda p: int(p.rsplit("-", 1)[-1]))
    loadable = lambda d: os.path.isfile(os.path.join(d, "config.json")) and os.path.isfile(os.path.join(d, "processor_config.json"))
    for cand in [*reversed(ckpts), root]:
        if loadable(cand):
            return cand
    if ckpts:
        return ckpts[-1]
    if os.path.isfile(os.path.join(root, "config.json")):
        return root
    raise FileNotFoundError(f"no config.json or checkpoint-N under {root}")


try:
    model_dir = pick_model_dir(args.model_root)
    report["model_path"] = model_dir
    cfg = args.modality_config or os.path.join(args.dataset, "modality_config.py")
    if os.path.isfile(cfg):
        runpy.run_path(cfg)  # registers the NEW_EMBODIMENT modality config, same as launch_finetune
    else:
        print(f"warning: no modality config at {cfg}; relying on the model's saved embodiment config")
    import numpy as np
    import torch
    from gr00t.data.embodiment_tags import EmbodimentTag
    from gr00t.policy.gr00t_policy import Gr00tPolicy

    tag_name = args.embodiment_tag.upper()
    tag = EmbodimentTag[tag_name] if tag_name in EmbodimentTag.__members__ else EmbodimentTag(args.embodiment_tag)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading {model_dir} on {device} (embodiment {tag.name})")
    t0 = time.time()
    policy = Gr00tPolicy(embodiment_tag=tag, model_path=model_dir, device=device, strict=True)
    load_s = round(time.time() - t0, 1)
    modality = policy.get_modality_config()
    print("modality config:", {k: v.modality_keys for k, v in modality.items()})

    # ---- smoke: one synthetic observation, action must be (horizon, action_dim) and finite
    mod = json.loads(Path(args.dataset, "meta", "modality.json").read_text())
    obs = {"video": {}, "state": {}, "language": {}}
    for k in modality["video"].modality_keys:
        obs["video"][k] = np.zeros((1, 1, 224, 224, 3), dtype=np.uint8)
    for k in modality["state"].modality_keys:
        r = mod["state"][k]
        obs["state"][k] = np.zeros((1, 1, int(r["end"]) - int(r["start"])), dtype=np.float32)
    for k in modality["language"].modality_keys:
        obs["language"][k] = [[args.language]]
    t0 = time.time()
    action, _info = policy.get_action(obs)
    infer_s = round(time.time() - t0, 2)
    parts = [np.asarray(action[k], dtype=float)[0] for k in modality["action"].modality_keys]
    arr = np.concatenate(parts, axis=-1)
    expected = sum(int(mod["action"][k]["end"]) - int(mod["action"][k]["start"]) for k in modality["action"].modality_keys)
    smoke_ok = arr.ndim == 2 and arr.shape[-1] == expected and bool(np.isfinite(arr).all()) and arr.size > 0
    report["smoke"] = {"passed": int(smoke_ok), "action_shape": list(arr.shape), "expected_action_dim": expected, "all_finite": int(bool(np.isfinite(arr).all())), "load_seconds": load_s, "inference_seconds": infer_s}
    print("smoke:", report["smoke"])

    # ---- open-loop evaluation on real trajectories (upstream implementation)
    from gr00t.data.dataset.lerobot_episode_loader import LeRobotEpisodeLoader
    from gr00t.eval import open_loop_eval as ole

    stats_path = os.path.join(args.dataset, "meta", "stats.json")
    if not os.path.isfile(stats_path):
        # The dataset copy is fresh (task inputs are read-only); regenerate the normalization statistics
        # the episode loader asserts on, exactly as launch_finetune did before training.
        from gr00t.data import stats as gr00t_stats
        print("meta/stats.json missing; generating dataset statistics")
        try:
            gr00t_stats.main(args.dataset, tag)
        except TypeError:
            gr00t_stats.generate_stats(args.dataset)
        print("stats generated:", os.path.isfile(stats_path))
    loader = None
    for backend in ("torchcodec", "decord", "torchvision_av"):
        try:
            loader = LeRobotEpisodeLoader(dataset_path=args.dataset, modality_configs=modality, video_backend=backend, video_backend_kwargs=None)
            print("video backend:", backend)
            break
        except Exception as e:  # noqa: BLE001  (backend not installed in this image)
            print(f"video backend {backend} unavailable: {type(e).__name__}: {e}")
    if loader is None:
        raise RuntimeError("no usable video backend for LeRobotEpisodeLoader")
    try:
        import matplotlib  # noqa: F401
        plots_ok = True
    except Exception:  # noqa: BLE001
        plots_ok = False
        print("matplotlib unavailable; skipping trajectory plots")
    n = min(args.trajectories, len(loader))
    per = []
    for i in range(n):
        plot = out / "plots" / f"traj_{i}.jpeg"
        mse, mae = ole.evaluate_single_trajectory(policy, loader, i, tag, None, steps=args.steps, action_horizon=args.action_horizon, save_plot_path=str(plot) if plots_ok else None)
        per.append({"trajectory": i, "mse": float(mse), "mae": float(mae), "plot": str(plot) if plots_ok else None})
        print(f"trajectory {i}: mse={float(mse):.6f} mae={float(mae):.6f}")
    mse_mean = float(np.mean([p["mse"] for p in per])) if per else None
    mae_mean = float(np.mean([p["mae"] for p in per])) if per else None
    report["open_loop"] = {"trajectories": n, "steps": args.steps, "action_horizon": args.action_horizon, "mse_mean": mse_mean, "mae_mean": mae_mean, "per_trajectory": per}

    mse_ok = args.max_mse <= 0 or (mse_mean is not None and mse_mean <= args.max_mse)
    gate_ok = smoke_ok and mse_ok
    reason = "ok" if gate_ok else ("smoke check failed" if not smoke_ok else f"mse_mean {mse_mean} > max_mse {args.max_mse}")
    report["gate"] = {"passed": int(gate_ok), "max_mse": args.max_mse, "reason": reason}
    finish(0 if gate_ok else 3)
except SystemExit:
    raise
except Exception as e:  # noqa: BLE001
    traceback.print_exc()
    report["error"] = f"LOAD_OR_INFER_FAILURE: {e!r}"
    report["gate"] = {"passed": 0, "max_mse": args.max_mse, "reason": "load or inference failure"}
    finish(2)
`;

/** Runs on a CPU node (python:3.11 + boto3 + mlflow): inference-only export, S3 upload for IsaacSim/DCV, MLflow model registration. */
export const GR00T_REGISTER_PY = String.raw`#!/usr/bin/env python3
"""GR00T register step: build an inference-only model directory (same filter as
e2e-workshop/groot/training/container/train.py copy_artifacts), upload it uncompressed to
s3://<bucket>/<prefix>/ (the path the DCV workstation mounts for IsaacSim), then attach the
evaluation metrics to the MLflow training run and register a model version with an alias."""
import argparse
import json
import mimetypes
import os
import shutil
import sys
import time
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig

ap = argparse.ArgumentParser()
ap.add_argument("--model-root", required=True)
ap.add_argument("--eval-dir", required=True)
ap.add_argument("--dataset-dir", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--bucket", required=True)
ap.add_argument("--prefix", required=True, help="S3 key prefix, e.g. models/groot-sm/wf-<id>")
ap.add_argument("--model-name", required=True, help="MLflow registered model name")
ap.add_argument("--alias", default="candidate")
ap.add_argument("--workflow-id", default=os.environ.get("PAI_WORKFLOW_ID", ""))
ap.add_argument("--base-model", default="")
ap.add_argument("--dataset-name", default="")
ap.add_argument("--hf-dataset-id", default="")
ap.add_argument("--embodiment-tag", default="NEW_EMBODIMENT")
args = ap.parse_args()

evaluation = json.loads(Path(args.eval_dir, "evaluation.json").read_text())
if not evaluation.get("gate", {}).get("passed"):
    print("gate did not pass, refusing to register:", evaluation.get("gate"))
    sys.exit(1)

SKIP_FILES = {"optimizer.pt", "optimizer.bin", "scheduler.pt", "rng_state.pth", "trainer_state.json", "training_args.bin", "scaler.pt", "latest", "zero_to_fp32.py"}


def skip(name: str) -> bool:
    return name in SKIP_FILES or name.startswith(("rng_state_", "global_step", "checkpoint-", ".sagemaker"))


def copy_filtered(src: Path, dst: Path) -> int:
    n = 0
    dst.mkdir(parents=True, exist_ok=True)
    for entry in sorted(os.listdir(src)):
        if skip(entry):
            print("  skip", entry)
            continue
        s, d = src / entry, dst / entry
        if s.is_dir():
            n += copy_filtered(s, d)
        else:
            shutil.copy2(s, d)
            n += 1
    return n


root = Path(args.model_root)
# Prefer the newest checkpoint-N: it holds weights + processor files together (the output root keeps
# the processor under processor/ only). Same choice the evaluate step made.
ckpts = sorted((p for p in root.glob("checkpoint-*") if p.name.rsplit("-", 1)[-1].isdigit()), key=lambda p: int(p.name.rsplit("-", 1)[-1]))
src_root = next((c for c in reversed(ckpts) if (c / "config.json").is_file() and (c / "processor_config.json").is_file()), None)
if src_root is None:
    if (root / "config.json").is_file():
        src_root = root
    elif ckpts:
        src_root = ckpts[-1]
    else:
        sys.exit(f"no final model or checkpoint under {root}")
export = Path(args.output) / "model"
if export.exists():
    shutil.rmtree(export)
print(f"exporting inference files from {src_root} -> {export}")
count = copy_filtered(src_root, export)
# mirror train.py: processor files must sit at the export root for Gr00tPolicy / the policy server
proc = export / "processor"
if src_root != root and (root / "processor").is_dir() and not proc.exists():
    shutil.copytree(root / "processor", proc)
if proc.is_dir() and not (export / "processor_config.json").is_file():
    for f in proc.iterdir():
        if f.is_file() and not (export / f.name).exists():
            shutil.copy2(f, export / f.name)
            count += 1

# what the policy server / IsaacSim side needs next to the weights
for rel in ["modality_config.py", "meta/modality.json"]:
    src = Path(args.dataset_dir, rel)
    if src.is_file():
        (export / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, export / rel)
meta_path = export / "inference_metadata.json"
if not meta_path.exists():
    meta_path.write_text(json.dumps({"embodiment_tag": args.embodiment_tag, "workflow_id": args.workflow_id}, indent=2))
shutil.copytree(args.eval_dir, export / "evaluation", dirs_exist_ok=True)
summary_path = Path(args.model_root, "training_summary.json")
training = json.loads(summary_path.read_text()) if summary_path.is_file() else {}

s3_uri = f"s3://{args.bucket}/{args.prefix.strip('/')}/"
ol = evaluation.get("open_loop", {})
card = [
    f"# {args.model_name}",
    "",
    f"- Workflow: {args.workflow_id}",
    f"- Base model: {args.base_model}",
    f"- Dataset: {args.dataset_name} ({args.hf_dataset_id})",
    f"- Embodiment tag: {args.embodiment_tag}",
    f"- Training: {json.dumps(training)}",
    f"- Smoke check: {json.dumps(evaluation.get('smoke'))}",
    f"- Open-loop MSE (mean over {ol.get('trajectories')} trajectories, {ol.get('steps')} steps): {ol.get('mse_mean')}",
    f"- Open-loop MAE: {ol.get('mae_mean')}",
    f"- Gate: {json.dumps(evaluation.get('gate'))}",
    f"- Uncompressed export: {s3_uri}",
    "",
    "Load with Gr00tPolicy(model_path=<this directory>) or point the policy server at the S3 mirror (DCV: /mnt/s3/groot).",
]
(export / "model-card.md").write_text("\n".join(card) + "\n")

# ---- upload uncompressed (multipart) so the DCV instance can aws s3 sync / mount it directly
s3 = boto3.client("s3")
cfg = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024, max_concurrency=8)
total = 0
t0 = time.time()
for f in sorted(p for p in export.rglob("*") if p.is_file()):
    key = f"{args.prefix.strip('/')}/{f.relative_to(export).as_posix()}"
    ctype = mimetypes.guess_type(f.name)[0]
    extra = {"ContentType": ctype} if ctype else {}
    s3.upload_file(str(f), args.bucket, key, Config=cfg, ExtraArgs=extra)
    total += f.stat().st_size
    print(f"  uploaded {key} ({f.stat().st_size / 1e6:.1f} MB)")
print(f"uploaded {count} files, {total / 1e9:.2f} GB in {time.time() - t0:.0f}s -> {s3_uri}")

# ---- MLflow: metrics onto the training run + registered model version
result = {"s3_uri": s3_uri, "files": count, "bytes": total, "mlflow": None}
uri = os.environ.get("MLFLOW_TRACKING_URI")
if uri:
    import mlflow
    from mlflow import MlflowClient

    mlflow.set_tracking_uri(uri)
    exp_name = os.environ.get("MLFLOW_EXPERIMENT_NAME", "gr00t-pipeline")
    exp = mlflow.set_experiment(exp_name)
    client = MlflowClient()
    train_run_name = f"{args.workflow_id}/finetune"
    runs = client.search_runs([exp.experiment_id], filter_string=f"tags.mlflow.runName = '{train_run_name}'", max_results=1)
    run_id = runs[0].info.run_id if runs else None
    with mlflow.start_run(run_id=run_id, run_name=None if run_id else f"{args.workflow_id}/register"):
        run_id = mlflow.active_run().info.run_id
        metrics = {"eval_smoke_passed": float(evaluation["smoke"].get("passed", 0)), "eval_gate_passed": float(evaluation["gate"].get("passed", 0))}
        if ol.get("mse_mean") is not None:
            metrics["eval_open_loop_mse"] = float(ol["mse_mean"])
        if ol.get("mae_mean") is not None:
            metrics["eval_open_loop_mae"] = float(ol["mae_mean"])
        for p in ol.get("per_trajectory", []):
            metrics[f"eval_open_loop_mse_traj{p['trajectory']}"] = float(p["mse"])
        mlflow.log_metrics(metrics)
        mlflow.set_tags({"pai.workflow_id": args.workflow_id, "pai.dataset": args.dataset_name, "pai.base_model": args.base_model, "pai.export_s3_uri": s3_uri, "pai.gate": "passed"})
        mlflow.log_artifact(str(Path(args.eval_dir, "evaluation.json")), artifact_path="evaluation")
        plots = Path(args.eval_dir, "plots")
        if plots.is_dir():
            mlflow.log_artifacts(str(plots), artifact_path="evaluation/plots")
        mlflow.log_artifact(str(export / "model-card.md"))
    try:
        client.create_registered_model(args.model_name, description="GR00T N1.6 fine-tuned by the Physical AI Dashboard gr00t-pipeline workflow")
    except Exception as e:  # noqa: BLE001  (already exists)
        print("registered model exists:", type(e).__name__)
    mv = client.create_model_version(
        name=args.model_name,
        source=s3_uri,
        run_id=run_id,
        description=f"workflow {args.workflow_id}: open-loop MSE {ol.get('mse_mean')}, smoke {evaluation['smoke'].get('passed')}",
        tags={"workflow_id": args.workflow_id, "dataset": args.dataset_name, "base_model": args.base_model, "open_loop_mse": str(ol.get("mse_mean")), "gate": "passed"},
    )
    if args.alias:
        client.set_registered_model_alias(args.model_name, args.alias, mv.version)
    result["mlflow"] = {"experiment": exp_name, "run_id": run_id, "registered_model": args.model_name, "version": int(mv.version), "alias": args.alias}
    print(f"registered {args.model_name} v{mv.version} (alias {args.alias}) on run {run_id}")
else:
    print("MLFLOW_TRACKING_URI not set; skipped MLflow registration")

Path(args.output, "register.json").write_text(json.dumps(result, indent=2))
print("REGISTER RESULT:", json.dumps(result))
`;
