# GR00T Workshop Notebooks

A notebook-based walkthrough of the workshop's VLA track (infra/base-model check → pipeline training → closed-loop evaluation). Use this instead of running the scripts directly via CLI when you want to execute cell by cell and inspect intermediate output.

> 한국어 문서: [README.ko.md](README.ko.md)

## Prerequisites

Before opening the notebooks, run the one-time setup script. It handles `uv` environment sync, Jupyter kernel registration (`GR00T (uv)`), code-server extension install, and populating `config.yaml` all at once.

```bash
cd e2e-workshop/groot
./setup-notebooks.sh <region>
```

## Notebooks

| File | Workshop Module | Description |
| --- | --- | --- |
| [`01_infra_and_base_check.ipynb`](./01_infra_and_base_check.ipynb) | Module 3 | Verifies infra deployment status + the GR00T base model |
| [`02_sagemaker_pipeline.ipynb`](./02_sagemaker_pipeline.ipynb) | Module 4 | Assembles and runs the 5-node SageMaker Pipeline (TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel/FailStep) — the core module. There's no separate dataset upload prep step; TransformDataset absorbs it |
| [`03_closed_loop_eval.ipynb`](./03_closed_loop_eval.ipynb) | Module 5 | Wrapper for the simulation closed-loop evaluation |

## Usage

1. Open code-server in your browser (the CodeServer URL from the deployment output).
2. Open the `.ipynb` files in this directory.
3. Select `GR00T (uv)` as the kernel.

### Fallback

If running notebooks in code-server isn't smooth, launch Jupyter Lab directly instead.

```bash
cd e2e-workshop/groot
uv run --extra notebooks jupyter lab --no-browser --port 8889
```

Access `http://localhost:8889` from a browser on the DCV desktop.

