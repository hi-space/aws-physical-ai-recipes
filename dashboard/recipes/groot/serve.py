"""Run the verified GR00T policy server against a directory or archived bundle."""
import argparse
from pathlib import Path
import runpy
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkpoint_bundle import inspect_checkpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True)
    args, remaining = parser.parse_known_args()
    # Container-local scratch never becomes a published evaluation output.
    with tempfile.TemporaryDirectory(prefix="pai-model-") as scratch:
        model, _ = inspect_checkpoint(args.model_path, Path(scratch) / "model")
        sys.argv = ["run_gr00t_server", "--model-path", str(model), *remaining]
        runpy.run_module("gr00t.eval.run_gr00t_server", run_name="__main__")


if __name__ == "__main__":
    main()
