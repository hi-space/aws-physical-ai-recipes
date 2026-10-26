#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Create the MLflow run for a fine-tune and print where its checkpoints go.

Emits shell assignments for the caller to eval, before training starts:

  MLFLOW_RUN_ID=0cf1...
  CKPT_DIR=/fsx/checkpoints/vla/mlflow/0cf1.../artifacts

CKPT_DIR rather than OUTPUT_DIR because the EKS job template is rendered by
envsubst, which would replace a ${OUTPUT_DIR} in the job's shell script with
the value from render time -- overwriting what this eval just assigned.

Used by both training paths so they stay in step:
  k8s-templates/rl/groot-finetune-job.yaml
  slurm-templates/vla/finetune_groot_venv.sbatch

Why the run is created here rather than by the Trainer: HF Trainer's
MLflowCallback starts its own run on train() and the run_id is only known
afterwards, which is too late to use as an output path. With MLFLOW_RUN_ID
exported the callback joins this run instead of opening a second one
(transformers/integrations/integration_utils.py reads the variable in
MLflowCallback.setup).

Why the output path is derived from the run: MLflow lists a run's Artifacts
tab from run.info.artifact_uri and nothing else, so a checkpoint is only
browsable there if it is written under that URI. The experiment's
artifact_location is set to s3://<bucket>/checkpoints/vla/mlflow by
scripts/eks/install-mlflow-selfhosted.sh, and FSx auto-exports
/fsx/checkpoints to s3://<bucket>/checkpoints, so writing to the FSx path
that mirrors the run's artifact root puts the bytes exactly where the UI
looks -- with no upload and no second copy of ~9 GB of weights.

Falls back to --fallback-output-dir, with no run created, when tracking is
off or the experiment's artifact_location is not under the export prefix
(e.g. an experiment created before the install script set the location, which
cannot be changed afterwards). Training then behaves as it did before.
"""

import argparse
import contextlib
import os
import sys
from pathlib import PurePosixPath


def fsx_path_for(artifact_uri: str, bucket: str, fsx_mount: str):
    """Map a run's s3:// artifact URI to the FSx path that exports to it.

    The data repository association maps /checkpoints <-> s3://<bucket>/checkpoints/,
    so only keys under that prefix have an FSx path at all.
    """
    prefix = f"s3://{bucket}/checkpoints/"
    if not artifact_uri.startswith(prefix):
        return None
    return str(PurePosixPath(fsx_mount) / "checkpoints" / artifact_uri[len(prefix):])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fallback-output-dir", required=True,
                    help="Printed as CKPT_DIR when the run cannot be nested")
    ap.add_argument("--run-name", default=os.environ.get("MLFLOW_RUN_NAME")
                    or os.environ.get("JOB_NAME") or None)
    ap.add_argument("--fsx-mount", default=os.environ.get("FSX_MOUNT", "/fsx"))
    args = ap.parse_args()

    def fallback(reason: str) -> int:
        print(f"[run-dir] {reason}", file=sys.stderr)
        print(f"CKPT_DIR={args.fallback_output_dir}")
        return 0

    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return fallback("MLFLOW_TRACKING_URI unset - keeping the plain output dir")

    try:
        from register_groot_model import resolve_bucket
        bucket = resolve_bucket()
    except Exception as e:
        return fallback(f"no artifact bucket ({e}) - cannot map an S3 artifact URI to FSx")

    experiment_name = os.environ.get("MLFLOW_EXPERIMENT_NAME", "vla-finetune")
    try:
        import mlflow

        # mlflow prints "View run ... at <url>" to stdout, and the caller evals
        # our stdout, so keep the whole client on stderr.
        with contextlib.redirect_stdout(sys.stderr):
            mlflow.set_experiment(experiment_name)
            run = mlflow.start_run(run_name=args.run_name)
            run_id = run.info.run_id
            artifact_uri = run.info.artifact_uri
            mlflow.end_run()  # the Trainer's callback reopens it via MLFLOW_RUN_ID
    except Exception as e:
        return fallback(f"could not create a run ({e}) - keeping the plain output dir")

    output_dir = fsx_path_for(artifact_uri, bucket, args.fsx_mount)
    if output_dir is None:
        print(f"[run-dir] run {run_id} artifact_uri is {artifact_uri}, which is not"
              f" under s3://{bucket}/checkpoints/ - checkpoints will not appear in"
              " the Artifacts tab", file=sys.stderr)
        print(f"[run-dir]   experiment '{experiment_name}' was created with a"
              " different artifact_location, and MLflow cannot change it."
              " See scripts/eks/install-mlflow-selfhosted.sh.", file=sys.stderr)
        print(f"MLFLOW_RUN_ID={run_id}")
        print(f"CKPT_DIR={args.fallback_output_dir}")
        return 0

    print(f"[run-dir] run {run_id} artifacts -> {artifact_uri}", file=sys.stderr)
    print(f"MLFLOW_RUN_ID={run_id}")
    print(f"CKPT_DIR={output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
