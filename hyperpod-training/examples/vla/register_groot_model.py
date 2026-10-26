#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Register a fine-tuned GR00T checkpoint as an MLflow model version.

Run after training, from the job that produced the checkpoint:

  python3 register_groot_model.py \
      --checkpoint-dir /fsx/checkpoints/vla/groot-so101-place-orange \
      --model-name groot-so101-place-orange

Registers a version and tags the run with the checkpoint's location.
Nothing is promoted and the weights are never copied.

Why registration is needed at all: MLflow already receives the training
metrics, but every fine-tune of the same dataset logs a run with the same
run_name and the same output_dir, so the runs are indistinguishable and none
of them records where its weights ended up. A model version carries the
checkpoint's S3 URI, so "which artifact did this run produce" becomes
answerable in the UI.

Why `source` is an s3:// URI and no upload happens: FSx /checkpoints is
auto-exported to S3 by the filesystem's data repository association, so the
same bytes are already in the bucket by the time training returns. Uploading
them into the MLflow artifact store would be a second ~7 GB copy of data the
account already holds. MLflow accepts an external source as long as the
server does not set MLFLOW_CREATE_MODEL_VERSION_SOURCE_VALIDATION_REGEX
(ours does not -- verified against the running 3.16 server).

The server serves those bytes itself: /model-versions/get-artifact resolves a
version's source with the tracking server's own credentials, so
`?name=<model>&version=<n>&path=config.json` returns the real file out of
s3://<bucket>/checkpoints/... with no copy anywhere. That requires the MLflow
pod role to hold s3:GetObject on checkpoints/* -- granted by
scripts/eks/install-mlflow-selfhosted.sh. Without it the request fails with an
S3 403 surfaced as INTERNAL_ERROR.

The run is tagged with the S3 URI and the FSx path so the location is visible
on the run's own page, not only on the model version.

Promotion is left to a human. Open-loop MSE is behaviour-cloning fidelity,
not task success, so it must not gate a release on its own; pick a version in
the MLflow UI and assign the alias there.

No-op when MLFLOW_TRACKING_URI is unset, and every failure is a warning
rather than an error -- a registration problem must not fail a fine-tune that
already wrote a valid checkpoint.
"""

import argparse
import os
import sys
from pathlib import Path


def s3_uri_for(fsx_path: str, bucket: str) -> str:
    """Map an FSx path to its auto-exported S3 URI.

    The data repository association maps /checkpoints <-> s3://<bucket>/checkpoints/,
    so dropping the /fsx prefix yields the S3 key.
    """
    return f"s3://{bucket}{fsx_path[len('/fsx'):]}"


def resolve_bucket() -> str:
    """Bucket name from the environment, else from the stack output.

    ARTIFACT_BUCKET is what the job template passes. The stack lookup is the
    fallback for a manual run on the head node, and follows the same
    HyperPodEks-<account> convention render.sh uses.
    """
    if os.environ.get("ARTIFACT_BUCKET"):
        return os.environ["ARTIFACT_BUCKET"]
    import boto3
    account = boto3.client("sts").get_caller_identity()["Account"]
    stack = os.environ.get("STACK_NAME", f"HyperPodEks-{account}")
    outputs = boto3.client("cloudformation").describe_stacks(
        StackName=stack)["Stacks"][0]["Outputs"]
    for o in outputs:
        if o["OutputKey"] == "S3BucketName":
            return o["OutputValue"]
    raise RuntimeError(f"stack {stack} has no S3BucketName output")


def log_checkpoint_location(client, run_id: str, ckpt: Path, source: str) -> None:
    """Record where the weights are, as tags on the run that produced them.

    Tags rather than uploaded files. The same bytes are already in FSx and in
    S3, so the run only needs to say which paths they are at; the MLflow
    server reads the S3 URI directly when the UI asks for a file.
    """
    total = sum(p.stat().st_size for p in ckpt.rglob("*") if p.is_file())
    client.set_tag(run_id, "checkpoint_s3_uri", f"{source}/")
    client.set_tag(run_id, "checkpoint_fsx_dir", str(ckpt))
    client.set_tag(run_id, "checkpoint_size_gib", f"{total / (1 << 30):.1f}")


def latest_checkpoint(output_dir: Path) -> Path:
    """Highest-numbered checkpoint-<step> directory, else output_dir itself.

    HF Trainer writes checkpoint-<step>/ subdirectories plus a final copy of
    the weights in output_dir. Prefer the numbered one so the registered
    version pins a specific step.
    """
    steps = []
    for p in output_dir.glob("checkpoint-*"):
        try:
            steps.append((int(p.name.split("-")[-1]), p))
        except ValueError:
            continue
    return max(steps)[1] if steps else output_dir


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--checkpoint-dir", required=True,
                    help="A checkpoint, or the training output dir to pick the latest from")
    ap.add_argument("--model-name", required=True)
    ap.add_argument("--groot-version", default=os.environ.get("GROOT_VERSION", "n1.6"))
    args = ap.parse_args()

    if not os.environ.get("MLFLOW_TRACKING_URI"):
        print("[register] MLFLOW_TRACKING_URI unset - skipping registration")
        return 0

    ckpt = latest_checkpoint(Path(args.checkpoint_dir))
    if not ckpt.is_dir():
        print(f"[WARN] no checkpoint at {ckpt} - skipping registration")
        return 0
    if not str(ckpt).startswith("/fsx/checkpoints/"):
        # Only /fsx/checkpoints is covered by the S3 auto-export, so anywhere
        # else would register a URI that holds nothing.
        print(f"[WARN] {ckpt} is outside /fsx/checkpoints (not auto-exported to S3)"
              " - skipping registration")
        return 0

    try:
        import mlflow
        from mlflow import MlflowClient

        source = s3_uri_for(str(ckpt), resolve_bucket())
        client = MlflowClient()

        try:
            client.create_registered_model(
                args.model_name,
                description=f"GR00T {args.groot_version} fine-tune of {ckpt.parent.name}")
        except Exception:
            pass  # already registered by an earlier run

        # Attach to the run the Trainer just finished so the metrics and the
        # artifact pointer sit on one record. mlflow_run_dir.py created that
        # run before training and exported its id; the search is the fallback
        # for a run opened by the Trainer's callback instead. The newest run in
        # the experiment is then ours -- the fine-tune job holds the GPU, so no
        # other run can interleave.
        run_id = os.environ.get("MLFLOW_RUN_ID") or None
        if not run_id:
            exp = mlflow.get_experiment_by_name(
                os.environ.get("MLFLOW_EXPERIMENT_NAME", "vla-finetune"))
            if exp:
                runs = client.search_runs([exp.experiment_id], max_results=1,
                                          order_by=["attributes.start_time DESC"])
                if runs:
                    run_id = runs[0].info.run_id

        version = client.create_model_version(
            name=args.model_name, source=source, run_id=run_id,
            tags={"fsx_dir": str(ckpt),
                  "checkpoint_step": ckpt.name.replace("checkpoint-", ""),
                  "groot_version": args.groot_version,
                  "job_name": os.environ.get("JOB_NAME", "")})

        if run_id:
            log_checkpoint_location(client, run_id, ckpt, source)

        print(f"[register] {args.model_name} version {version.version}")
        print(f"[register]   source : {source}")
        print(f"[register]   run_id : {run_id}")
        print("[register]   assign an alias in the MLflow UI to promote this version")
    except Exception as e:
        print(f"[WARN] model registration failed: {e}. The checkpoint is unaffected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
