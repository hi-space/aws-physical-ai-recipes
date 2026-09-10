# GR00T SageMaker Pipeline

Runs data preparation → training → smoke validation → gate → model registration as a single SageMaker Pipeline execution.

> 한국어 문서: [README.ko.md](README.ko.md)

## Overview

If you only need to run training once, [`../training/scripts/run_training.py`](../training/scripts/run_training.py) is enough. This pipeline adds data preparation and sanity validation before and after it, plus a gate that registers only models that pass into the Model Registry — a **5-node pipeline**.

```
TransformDataset → GR00TFinetune → SmokeEval → SmokeGate ─┬─(pass)→ RegisterModel(Approved)
                                                            └─(fail)→ FailStep
```

- **TransformDataset** (`ProcessingStep`) — Downloads the HF dataset, converts v3→v2.1 if needed, then validates and stages it. This step absorbs the dataset upload prep step that used to be done manually from the notebook/CLI.
- **GR00TFinetune** (`TrainingStep`) — Uses the existing training container (`../training/container/train.py`) as-is. Receives TransformDataset's output as its training input channel.
- **SmokeEval** (`ProcessingStep`) — Loads the trained checkpoint offline and only checks that `get_action` inference produces a valid shape/finite values.
- **SmokeGate** (`ConditionStep`) — Branches based on the SmokeEval result (`smoke.passed` in `evaluation.json`). This is **not a quality-metric gate (e.g. accuracy) but a sanity + governance gate that checks whether the model loads and inference runs**. On pass, the `RegisterModel` step registers it into the Model Registry with **Approved** status; on failure, the pipeline execution fails at `FailStep`.

  > Note: if SmokeGate fails on the **first real pipeline run**, it's more likely that one of `smoke_eval.py`'s UNVERIFIED assumptions (policy import path, observation/action schema, etc.) is wrong rather than a model quality issue. Check `smoke.error` in `evaluation.json` — a `LOAD_OR_INFER_FAILURE:` prefix means a spike-assumption problem, while `action_shape` being populated with no prefix means an actual shape mismatch.

Separately, the behavior where `train.py` exports the unpacked checkpoint directly to S3 at the end of the training job, at the location given by the `export_s3_uri` hyperparameter (see the uncompressed export section below), always runs **independently of SmokeGate** — meaning the S3 export may already be complete even if the model fails the gate and is never registered in the Model Registry. If a consuming pipeline (e.g. IsaacSim) needs a guarantee that "only gate-passed models are used," it must check the Model Registry's Approved status.

Model version and metric tracking are unified under **MLflow** (attached to the training step, configured via `mlflow.*` in config.yaml).

## Project Structure

| File | Role |
|------|------|
| `build_pipeline.py` | A pure function (`build_pipeline(...)`) that wires the 5 steps above into a `Pipeline` object. Pipeline definition, registration, and execution is done by calling this function from the notebook (`../notebooks/02_sagemaker_pipeline.ipynb`) instead of via CLI. |
| `smoke_eval.py` | Entrypoint for the SmokeEval step. Loads the checkpoint, checks inference sanity only, and writes out `evaluation.json` (see the SmokeGate description above). |

The dataset download/conversion/validation logic (`transform_dataset.py`) lives under `../training/data/`, and the TransformDataset step calls it.

## Getting Started

```bash
cd ../  # groot/
./setup-notebooks.sh   # run once (prepares kernel/dependencies)
```

Open [`../notebooks/02_sagemaker_pipeline.ipynb`](../notebooks/02_sagemaker_pipeline.ipynb) in code-server and run the cells in order. The notebook covers everything: creating the Model Package Group, defining/upserting the Pipeline via `build_pipeline`, and running it (5 steps). There is no separate dataset upload prep step — the TransformDataset step absorbs that role. See [`../notebooks/README.md`](../notebooks/README.md) for detailed usage.

## Configuration

Defaults are read from the parent `config.yaml`, and notebook cell parameters take precedence. Commonly used options:

| Option | Description |
|------|------|
| `dataset.hf_dataset_id` | HF dataset ID that TransformDataset downloads |
| `transform.instance_type` | Instance type for the TransformDataset step |
| `training.max_steps`, `save_steps`, `instance_type`, `num_gpus` | Training options (same as `run_training.py`). All four become the defaults for the pipeline parameters (`MaxSteps`/`SaveSteps`/`InstanceType`/`NumGpus`), which can be overridden at execution time |
| `eval.instance_type` | Instance type for the SmokeEval step |
| `model.package_group_name` | Model Package Group name that RegisterModel registers into |
| `use_spot` | Whether to use Spot Instances |
| `groot_version` | `n1.6` or `n1.7` |

The export target prefix uses `model.s3_prefix` in `config.yaml` (default `models/groot-sm`).

## Model Registry (on SmokeGate pass)

- An execution that passes SmokeGate registers the model with **Approved** status, via the `RegisterModel` step, into the Model Package Group named by `model.package_group_name` in `config.yaml` (default `groot-sm-models`).
- Registered versions and approval status can be checked in the **Model Registry** tab of the SageMaker console.
- A failed execution fails the pipeline itself at `FailStep`, and nothing gets registered in the Model Registry.

## Uncompressed export (for IsaacSim consumption)

The uncompressed export is performed by the training step (`GR00TFinetune`) on every run, regardless of the SmokeGate result.

1. After a pipeline run, an uncompressed model directory is created at `s3://<bucket>/<model.s3_prefix>/<execution-id>/`.
2. Pulling it on the DCV instance with `aws s3 sync s3://<bucket>/<model.s3_prefix>/<execution-id>/ <local-path>` lets you load it directly into IsaacSim/Policy Server with no tar extraction needed.
3. If the IsaacLab stack was deployed with `-c enableFsx=true`, the groot stack sets up DRA on this bucket, so the same content automatically appears at `/fsx/groot/<model.s3_prefix>/<execution-id>/`.
4. To use "only gate-passed models," cross-check the Model Registry's Approved status above against the execution-id.

## See Also

- Training container / env var details: [`../training/README.md`](../training/README.md)
- Dataset download/conversion/validation (logic that TransformDataset calls): [`../training/data/transform_dataset.py`](../training/data/transform_dataset.py)
- Simulation closed-loop evaluation (ZMQ Policy Server): [`../inference/README.md`](../inference/README.md)
