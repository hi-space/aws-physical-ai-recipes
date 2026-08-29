# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Mirror Isaac Lab TensorBoard scalars to SageMaker Managed MLflow in real time.

Activated by calling install() before argparse.parse_args() runs (see
train_isaaclab.py). No-op when MLFLOW_TRACKING_URI is unset — the RL track's
MLflow server is provisioned by Module 7's CDK stack (MlflowConstruct), but
is optional (enableMlflow=false disables it).

Two monkey-patches:
  - argparse.ArgumentParser.parse_args / parse_known_args -> on the first
    call whose namespace contains "task", start an MLflow run and log the
    parsed CLI namespace as run params.
  - torch.utils.tensorboard.SummaryWriter.add_scalar -> mirror each scalar
    to a queue drained by a background thread that batch-writes via
    MlflowClient.log_batch (up to 1000 metrics every ~2 s). RSL-RL's
    OnPolicyRunner writes to this SummaryWriter internally, so no changes
    to train_isaaclab.py's training loop are needed.

finalize() drains the queue, uploads MLFLOW_ARTIFACT_DIR (if set), and
ends the run. It is registered with atexit so it runs on normal exit or
sys.exit(); it is also invoked from a patched isaacsim.SimulationApp.close()
since Omniverse Kit's native shutdown can bypass atexit on some paths.
"""

import atexit
import os
import queue
import re
import threading
import time

_state = {
    "run_id": None,
    "queue": None,
    "thread": None,
    "stop": None,
    "client": None,
    "warned": False,
}
_INVALID_TAG_CHARS = re.compile(r"[^A-Za-z0-9_\-. :/]")


def install():
    """Install monkey-patches on argparse and SummaryWriter."""
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return

    try:
        import argparse
        from torch.utils.tensorboard import SummaryWriter

        orig_add_scalar = SummaryWriter.add_scalar

        def patched_add_scalar(self, tag, value, global_step=None, *a, **kw):
            orig_add_scalar(self, tag, value, global_step, *a, **kw)
            if _state["queue"] is None:
                return
            try:
                from mlflow.entities import Metric
                _state["queue"].put_nowait(Metric(
                    key=_INVALID_TAG_CHARS.sub("_", tag),
                    value=float(value),
                    timestamp=int(time.time() * 1000),
                    step=int(global_step or 0),
                ))
            except Exception:
                pass

        SummaryWriter.add_scalar = patched_add_scalar

        # ArgumentParser.parse_args / parse_known_args -> start MLflow run on
        # the first invocation whose namespace contains "task" (that's
        # train_isaaclab.py's own CLI, not AppLauncher's Kit args parser).
        orig_parse_args = argparse.ArgumentParser.parse_args
        orig_parse_known_args = argparse.ArgumentParser.parse_known_args

        def _maybe_start(ns):
            if _state["run_id"] is None and "task" in vars(ns):
                _start_run(ns)

        def patched_parse_args(self, *a, **kw):
            ns = orig_parse_args(self, *a, **kw)
            _maybe_start(ns)
            return ns

        def patched_parse_known_args(self, *a, **kw):
            ns, rest = orig_parse_known_args(self, *a, **kw)
            _maybe_start(ns)
            return ns, rest

        argparse.ArgumentParser.parse_args = patched_parse_args
        argparse.ArgumentParser.parse_known_args = patched_parse_known_args
    except Exception as e:
        print(f"[WARN] MLflow hook install failed: {e}")


def _start_run(args_namespace):
    try:
        import mlflow
        mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
        mlflow.set_experiment(os.environ.get("MLFLOW_EXPERIMENT_NAME", "isaaclab-rl"))

        run_name = (
            os.environ.get("MLFLOW_RUN_NAME")
            or getattr(args_namespace, "task", None)
            or "isaaclab-rl-run"
        )
        run = mlflow.start_run(run_name=run_name)
        _state["run_id"] = run.info.run_id

        params = {
            k: str(v) for k, v in vars(args_namespace).items()
            if isinstance(v, (str, int, float, bool)) or v is None
        }
        if params:
            try:
                mlflow.log_params(params)
            except Exception as e:
                print(f"[WARN] MLflow log_params failed: {e}")

        _state["client"] = mlflow.tracking.MlflowClient()
        _state["queue"] = queue.Queue()
        _state["stop"] = threading.Event()
        _state["thread"] = threading.Thread(target=_worker, daemon=True)
        _state["thread"].start()
        atexit.register(finalize)
        _patch_simulation_app_close()

        print(f"[MLflow] run_id={_state['run_id']} run_name={run_name}", flush=True)
    except Exception as e:
        print(f"[WARN] MLflow start_run failed: {e}. Training continues without tracking.")


def _patch_simulation_app_close():
    """Patch isaacsim.SimulationApp.close to call finalize() before shutdown.

    Isaac Sim's SimulationApp.close() invokes Omniverse Kit's native shutdown
    which can terminate the process before Python's atexit/finally hooks run.
    Patching .close() ensures we get the chance to drain the metric queue,
    upload artifacts, and end the MLflow run before the kit goes down.
    """
    try:
        from isaacsim import SimulationApp
        orig_close = SimulationApp.close

        def patched_close(self, *a, **kw):
            try:
                finalize()
            except Exception as e:
                print(f"[WARN] MLflow finalize() in SimulationApp.close failed: {e}", flush=True)
            return orig_close(self, *a, **kw)

        SimulationApp.close = patched_close
    except Exception as e:
        print(f"[WARN] Could not patch SimulationApp.close: {e}", flush=True)


def _worker():
    """Drain the queue, batch-log every ~2 s or every 1000 metrics."""
    pending = []
    while not _state["stop"].is_set() or not _state["queue"].empty() or pending:
        try:
            pending.append(_state["queue"].get(timeout=2.0))
            while len(pending) < 1000:
                try:
                    pending.append(_state["queue"].get_nowait())
                except queue.Empty:
                    break
        except queue.Empty:
            pass
        if pending:
            try:
                _state["client"].log_batch(_state["run_id"], metrics=pending)
            except Exception as e:
                if not _state["warned"]:
                    print(f"[WARN] MLflow log_batch failed: {e}. Continuing silently.")
                    _state["warned"] = True
            pending = []


def _resolve_artifact_dir():
    """Resolve the per-run log directory, scanning for the most recent run.

    The user supplies MLFLOW_ARTIFACT_DIR as a parent path (e.g.
    /fsx/checkpoints/rl). train_isaaclab.py nests each run under
    <task_short>/<experiment_name>/<timestamp>_ppo_torch/, so we cannot
    construct the exact per-run path from env vars upfront. Pick the most
    recently modified directory within the parent that has a `checkpoints/`
    subdirectory - that's the current training run.

    Returns None if the parent is unset or missing.
    """
    parent = os.environ.get("MLFLOW_ARTIFACT_DIR")
    if not parent or not os.path.isdir(parent):
        return None
    candidates = []
    for root, dirs, _files in os.walk(parent):
        if "checkpoints" in dirs:
            candidates.append((os.path.getmtime(root), root))
        dirs[:] = [d for d in dirs if d != "checkpoints"]
    if not candidates:
        return parent
    candidates.sort()
    return candidates[-1][1]


def finalize():
    """Drain queue, upload the current run's artifact directory, end run.

    Idempotent. train_isaaclab.py runs one process per Slurm job (no DDP),
    so there is only ever one MLflow run to finalize per job.
    """
    if _state["run_id"] is None:
        return
    print(f"[MLflow] finalize: ending run {_state['run_id']}", flush=True)
    try:
        import mlflow
        _state["stop"].set()
        _state["thread"].join(timeout=30)

        artifact_dir = _resolve_artifact_dir()
        if artifact_dir and os.path.isdir(artifact_dir):
            try:
                print(f"[MLflow] uploading artifacts from {artifact_dir}", flush=True)
                mlflow.log_artifacts(artifact_dir)
            except Exception as e:
                print(f"[WARN] MLflow log_artifacts failed: {e}", flush=True)
        else:
            print(f"[MLflow] no artifact directory found under MLFLOW_ARTIFACT_DIR={os.environ.get('MLFLOW_ARTIFACT_DIR')}", flush=True)

        mlflow.end_run()
        print("[MLflow] run ended", flush=True)
    except Exception as e:
        print(f"[WARN] MLflow finalize failed: {e}", flush=True)
    finally:
        _state["run_id"] = None
