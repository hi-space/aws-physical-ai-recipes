#!/usr/bin/env python3
"""Apply GR00T fine-tuning compatibility patches to a checked-out Isaac-GR00T tree.

Both orchestration paths call this so the patch set has exactly one definition:

  Slurm  slurm-templates/vla/finetune_groot_venv.sbatch
  EKS    k8s-templates/rl/groot-finetune-job.yaml

Usage:
  python3 patch_groot_repo.py --repo /fsx/scratch/Isaac-GR00T --version n1.6

The patches are idempotent: re-running on an already-patched tree is a no-op,
which matters because /fsx is shared and both paths may run against the same
clone. Every edit is reported, and a target that no longer matches is a hard
failure (exit 1) rather than a silent skip -- an upstream rename shows up here
as "NO MATCH" instead of as an inscrutable CUDA dtype error 20 minutes into
training. Patterns are therefore only listed if they have a real target at the
pinned release ref; a pattern kept "just in case" would mask that signal.

Why each patch is needed:

  load_bf16                      the Eagle/Qwen3 backbone only runs under
                                 flash_attn in bf16; the default fp32 load path
                                 raises at the first attention call.
  backbone_trainable_params_fp32 upstream casts trainable backbone params back
                                 to fp32 after the bf16 load, re-breaking
                                 flash_attn.
  gradient_checkpointing         a 3B model at global batch 32 does not fit in
                                 24 GB (g5.8xlarge A10G) without it.
  paged_adamw_8bit (n1.6)        same VRAM reason; the paged optimizer keeps
                                 optimizer state off the device.
  safe device/dtype              upstream reads `next(self.parameters()).dtype`,
                                 which raises StopIteration on modules holding
                                 no parameters (during __init__ and for
                                 parameter-free submodules). Python 3.7+ turns a
                                 StopIteration crossing a generator boundary
                                 into RuntimeError, so it surfaces as an
                                 unrelated error far from the cause.
  flash_attention_2 inject       AutoModel.from_config otherwise selects the
                                 eager attention implementation and the
                                 flash-attn wheel goes unused.
  VideoInput shim                transformers<5.0 has no VideoInput symbol, so
                                 the Eagle processor fails at import time.
  report_to                      upstream only ever reports to wandb, and the
                                 workshop runs --no-use-wandb, so loss and
                                 learning rate never left stdout -- neither
                                 MLflow nor TensorBoard saw a fine-tune run.

Pinned refs this was verified against (tags, not branches):
  n1.6  n1.6-release   10 patches apply
  n1.7  n1.7-release    6 patches apply
"""

import argparse
import os
import re
import sys
from pathlib import Path

# Reading dtype/device off the first parameter raises StopIteration when a
# module holds none. Walk submodules instead and fall back to the values the
# fine-tune actually runs in.
SAFE_DEVICE = (
    "(lambda s: next((p.device for m in s.modules() for p in m.parameters()), "
    "__import__('torch').device('cuda')))(self)"
)
SAFE_DTYPE = (
    "(lambda s: next((p.dtype for m in s.modules() for p in m.parameters()), "
    "__import__('torch').bfloat16))(self)"
)
# Shared by both replacements above, so its presence means the file is patched.
SAFE_MARKER = "for m in s.modules() for p in m.parameters()"

# Upstream hardcodes report_to to wandb-or-nothing, and the workshop runs with
# --no-use-wandb, so every metric stayed in stdout: nothing reached MLflow or
# TensorBoard. HF Trainer already ships callbacks for both and MLflowCallback
# reads MLFLOW_TRACKING_URI / MLFLOW_EXPERIMENT_NAME from the environment, so
# naming the integrations here is all that is needed -- no logging code.
#
# Each entry is gated on its package being importable, because TrainingArguments
# raises on an integration whose package is absent. setup_groot_env.sh installs
# both, but venvs built before that change only have mlflow, and /fsx is shared
# so old and new coexist. Gating makes the patch degrade to whatever is present
# instead of failing the run.
REPORT_TO = (
    '[i for i in ("mlflow", "tensorboard") if getattr('
    "__import__('transformers.integrations.integration_utils', fromlist=['x']), "
    "'is_' + i + '_available')()]"
)
REPORT_TO_MARKER = "'is_' + i + '_available'"


class Patcher:
    def __init__(self, repo: Path):
        self.repo = repo
        self.applied = 0
        self.skipped = 0
        self.missing = 0

    def _read(self, rel: str):
        path = self.repo / rel
        if not path.exists():
            print(f"  [missing] {rel}")
            self.missing += 1
            return None, None
        return path, path.read_text()

    def replace(self, rel: str, old: str, new: str, *, label: str, marker: str = None):
        """Literal replacement. Treats an already-patched file as success.

        Insertion-style patches keep `old` inside `new`, so "is old still
        present" cannot detect prior application -- it would re-insert on every
        run. Those callers pass `marker`: text unique to the patched result.
        """
        path, code = self._read(rel)
        if code is None:
            return
        if (marker or new) in code:
            print(f"  [already] {label} ({rel})")
            self.skipped += 1
            return
        if old not in code:
            print(f"  [NO MATCH] {label} ({rel}) -- upstream may have renamed this")
            self.missing += 1
            return
        path.write_text(code.replace(old, new))
        print(f"  [applied] {label} ({rel})")
        self.applied += 1

    def regex(self, rel: str, patterns: list, *, label: str, marker: str):
        """Regex substitutions, all applied to one file in a single write.

        A no-op has two very different causes: the file is already patched, or
        the pattern no longer matches anything. `marker` (text present only in
        the patched result) tells them apart, so an upstream rename is reported
        as NO MATCH and fails the run instead of passing as "already".
        """
        path, code = self._read(rel)
        if code is None:
            return
        before = code
        for pattern, repl in patterns:
            # re.sub reads backslashes in the replacement as group references;
            # the lambda keeps SAFE_* literal.
            code = re.sub(pattern, lambda _m, r=repl: r, code)
        if code == before:
            if marker in code:
                print(f"  [already] {label} ({rel})")
                self.skipped += 1
            else:
                print(f"  [NO MATCH] {label} ({rel}) -- upstream may have renamed this")
                self.missing += 1
            return
        path.write_text(code)
        print(f"  [applied] {label} ({rel})")
        self.applied += 1


def patch_common(p: Patcher):
    p.replace(
        "gr00t/experiment/launch_finetune.py",
        "config.model.load_bf16 = False",
        "config.model.load_bf16 = True",
        label="load model in bf16",
    )
    p.replace(
        "gr00t/experiment/launch_finetune.py",
        "config.model.backbone_trainable_params_fp32 = True",
        "config.model.backbone_trainable_params_fp32 = False",
        label="keep backbone params in bf16",
    )
    p.replace(
        "gr00t/configs/training/training_config.py",
        "gradient_checkpointing: bool = False",
        "gradient_checkpointing: bool = True",
        label="enable gradient checkpointing",
    )
    p.regex(
        "gr00t/model/modules/dit.py",
        [(r"next\(self\.parameters\(\)\)\.dtype", SAFE_DTYPE)],
        label="safe dtype in dit",
        marker=SAFE_MARKER,
    )
    p.replace(
        "gr00t/experiment/experiment.py",
        '        report_to="wandb" if config.training.use_wandb else "none",',
        f"        report_to={REPORT_TO},\n"
        "        run_name=experiment_name,",
        label="report metrics to MLflow/TensorBoard",
        marker=REPORT_TO_MARKER,
    )


def patch_n16(p: Patcher):
    p.replace(
        "gr00t/experiment/launch_finetune.py",
        'config.training.optim = "adamw_torch"',
        'config.training.optim = "paged_adamw_8bit"',
        label="paged 8-bit optimizer",
    )
    p.replace(
        "gr00t/model/gr00t_n1d6/setup.py",
        '            missing_keys = loading_info.get("missing_keys", [])',
        "            import torch as _torch\n"
        "            model = model.to(_torch.bfloat16)\n"
        '            missing_keys = loading_info.get("missing_keys", [])',
        label="cast model to bf16 after from_pretrained",
        marker="model = model.to(_torch.bfloat16)",
    )
    p.regex(
        "gr00t/model/gr00t_n1d6/gr00t_n1d6.py",
        [
            (r"next\(iter\(self\.parameters\(\)\)\)\.device", SAFE_DEVICE),
            (r"next\(iter\(self\.parameters\(\)\)\)\.dtype", SAFE_DTYPE),
        ],
        label="safe device/dtype in gr00t_n1d6",
        marker=SAFE_MARKER,
    )
    p.replace(
        "gr00t/model/modules/eagle_backbone.py",
        "self.model = AutoModel.from_config(config, trust_remote_code=True)",
        'config._attn_implementation = "flash_attention_2"\n'
        "            self.model = AutoModel.from_config(config, trust_remote_code=True)",
        label="inject flash_attention_2",
        marker='config._attn_implementation = "flash_attention_2"',
    )
    patch_video_input(p)


def patch_video_input(p: Patcher):
    """transformers<5.0 has no VideoInput; alias it so the processor imports."""
    rel = "gr00t/model/modules/nvidia/Eagle-Block2A-2B-v2/processing_eagle3_vl.py"
    path = p.repo / rel
    if not path.exists():
        # Only present once the Eagle weights have been fetched.
        print(f"  [skip] VideoInput shim -- {rel} not present yet")
        p.skipped += 1
        return
    code = path.read_text()
    if "VideoInput = Any" in code:
        print(f"  [already] VideoInput shim ({rel})")
        p.skipped += 1
        return
    old = "from transformers.image_utils import (\n    ImageInput,\n    VideoInput,"
    if old not in code:
        print(f"  [skip] VideoInput shim -- import block not found ({rel})")
        p.skipped += 1
        return
    code = "from typing import Any\nVideoInput = Any\n" + code.replace(
        old, "from transformers.image_utils import (\n    ImageInput,"
    )
    path.write_text(code)
    print(f"  [applied] VideoInput shim ({rel})")
    p.applied += 1


def patch_n17(p: Patcher):
    p.regex(
        "gr00t/model/gr00t_n1d7/gr00t_n1d7.py",
        [
            (r"next\(iter\(self\.parameters\(\)\)\)\.device", SAFE_DEVICE),
            (r"next\(iter\(self\.parameters\(\)\)\)\.dtype", SAFE_DTYPE),
        ],
        label="safe device/dtype in gr00t_n1d7",
        marker=SAFE_MARKER,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("GR00T_REPO", "/fsx/scratch/Isaac-GR00T"))
    ap.add_argument("--version", default=os.environ.get("GROOT_VERSION", "n1.6"),
                    choices=["n1.6", "n1.7"])
    args = ap.parse_args()

    repo = Path(args.repo)
    if not (repo / "gr00t").is_dir():
        print(f"ERROR: no gr00t package under {repo}")
        print("  Expected a checked-out Isaac-GR00T tree. Run scripts/setup_groot_env.sh first.")
        return 1

    print(f"Patching {repo} for GR00T {args.version}")
    p = Patcher(repo)
    patch_common(p)
    if args.version == "n1.6":
        patch_n16(p)
    else:
        patch_n17(p)

    print(f"  applied={p.applied} already/skipped={p.skipped} missing={p.missing}")
    if p.missing:
        print("ERROR: some patch targets were absent or no longer match.")
        print(f"  The checkout may not be the {args.version} release branch.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
