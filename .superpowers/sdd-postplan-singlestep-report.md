# Report: single-step SageMaker pipeline refactor (drop ExportModelForFsx)

## Status
DONE. One commit created on branch `feat/e2e-workshop`.

## Commit
`49b702c` — `refactor(groot): single-step pipeline — train.py source-side FSx export, drop ExportModelForFsx`

```
 e2e-workshop/README.md                             |  2 +-
 e2e-workshop/groot/README.md                       | 10 ++---
 e2e-workshop/groot/inference/README.md             |  2 +-
 .../groot/notebooks/07_sagemaker_pipeline.ipynb    | 38 ++++-------------
 .../groot/notebooks/08_closed_loop_eval.ipynb      |  2 +-
 e2e-workshop/groot/pipeline/README.md              | 20 ++++-----
 e2e-workshop/groot/pipeline/export_model.py        | 48 ----------------------
 7 files changed, 25 insertions(+), 97 deletions(-)
```
Exactly the intended 7 files — nothing else (no stray generator, no teammate files) was staged/committed.

## CHANGE 1 — notebooks/07_sagemaker_pipeline.ipynb (rebuilt via nbformat, throwaway script at /tmp/edit_notebook.py, deleted after use — not committed)

Edits made, all other cells preserved verbatim:
- Cell 0 (title markdown): removed "Train → ExportModelForFsx 두 스텝" wording; now describes single training-step pipeline with source-side direct upload.
- Cell 9 (estimator/TrainingStep cell): inserted `model_prefix` and `export_s3_uri = Join(on="/", values=[f"s3://{BUCKET}/{model_prefix}", ExecutionVariables.PIPELINE_EXECUTION_ID])` right after `checkpoint_s3`, and added `"export_s3_uri": export_s3_uri` to the `hyperparameters={...}` dict. Imports in this cell (`Join`, `ExecutionVariables`, `TrainingStep`, `Estimator`, `TrainingInput`) were already present/kept unchanged.
- Cell 10 (markdown before the export step) + cell 11 (ExportModelForFsx `ProcessingStep`/`SKLearnProcessor`/`ProcessingInput`/`ProcessingOutput` code cell): cell 11 deleted entirely; cell 10 replaced with a short Korean explanation of source-side export via `export_s3_uri` hyperparameter (no literal "ExportModelForFsx" or "ProcessingStep" string used, to satisfy the zero-grep requirement while still conveying the "no separate processing step" idea via "별도의 처리 단계 없이").
- Pipeline assembly cell: `steps=[training_step, export_step]` → `steps=[training_step]`.
- `pipeline.start(parameters={...})` cell: left untouched (EmbodimentTag/DatasetS3Uri/MaxSteps/GlobalBatchSize only, no export params added).
- Completion markdown (last cell): rewritten to state the training job itself uploads the uncompressed model directly to `s3://<bucket>/<model_prefix>/<execution-id>/`, no separate step, then FSx-mount as before.

Notebook went from 18 cells to 17 cells (one code cell removed, none added).

### Verification (actual output)
```
grep -c "ExportModelForFsx" notebooks/07_sagemaker_pipeline.ipynb  → 0
grep -c "ProcessingStep" notebooks/07_sagemaker_pipeline.ipynb     → 0
grep -q "export_s3_uri" ...                                        → present
grep -q "GR00TFinetune" ...                                        → present
nbformat.validate(nb)                                               → OK (17 cells)
kernelspec metadata                                                  → {'display_name': 'GR00T (uv)', 'language': 'python', 'name': 'groot'} (unchanged)
```

## CHANGE 2 — delete export_model.py
`git rm e2e-workshop/groot/pipeline/export_model.py` — confirmed removed; `ls` on the path now fails with "No such file or directory". Confirmed no remaining references to `export_model` anywhere in `*.md/*.ipynb/*.py/*.ts` under `e2e-workshop`.

## CHANGE 3 — docs updated (mechanism description only, outcome preserved)
- `e2e-workshop/groot/pipeline/README.md`: rewrote Overview diagram/bullets and Project Structure section (removed the `export_model.py` table row since the file no longer exists) and the "Getting Started" sentence, all now describing the single-step train.py-side export via `export_s3_uri`.
- `e2e-workshop/groot/README.md`: updated the pipeline flow diagram, the "Pipeline으로 학습 + FSx용 export" section text, the internal-flow sentence, and the "학습 결과 소비" table row.
- `e2e-workshop/groot/inference/README.md`: updated the note about how the FSx-mounted model artifact is produced.
- `e2e-workshop/groot/notebooks/08_closed_loop_eval.ipynb`: updated the one markdown mention ("SageMaker Pipeline의 `ExportModelForFsx` 스텝 결과물" → "학습 잡이 source에서 직접 업로드한 결과물"), edited via nbformat (throwaway script `/tmp/edit_nb08.py`, deleted, not committed) and re-validated.
- `e2e-workshop/README.md`: updated the "MLOps 통합" bullet mechanism description (was "FSx용 export(model.tar.gz 압축 해제 후 S3 배치)", now describes the single-step train-side upload). This file was in fact changed, so it is included in the commit per the conditional instruction.

`e2e-workshop/groot/training/README.md` and `run_training.py`'s own `ExportModelForFsx` mention (`groot/training/scripts/run_training.py:224`) were intentionally **not** touched — `run_training.py` is teammate's uncommitted work (excluded per instructions), and `training/README.md` was not in the enumerated doc list; the Change-3 verification grep is scoped to `--include=*.md --include=*.ipynb`, and `training/README.md` had no `ExportModelForFsx` hits in the initial grep survey.

### Verification (actual output)
```
grep -rn "ExportModelForFsx" e2e-workshop --include=*.md --include=*.ipynb
→ (no output, grep exit code 1 = zero matches)
```

## Teammate files — untouched
`git status --short` after the commit still shows these as unstaged/uncommitted (i.e. left exactly as the teammate had them, not staged, not committed):
```
 M e2e-workshop/groot/config.yaml
 M e2e-workshop/groot/training/container/train.py
 M e2e-workshop/groot/training/scripts/run_training.py
```
All the other pre-existing unrelated uncommitted deletions/modifications in the working tree (sagemaker real-time endpoint removal, CDK lambda-deploy-endpoint removal, etc.) were also left completely alone — not staged, not committed, not edited.

Checked `git diff HEAD -- <file>` for each of the 6 doc/notebook files *before* committing to confirm each diff contained only the intended ExportModelForFsx-related edits and no accidental inclusion of unrelated pre-existing working-tree changes — confirmed clean in every case.

No throwaway generator scripts were committed (`/tmp/edit_notebook.py`, `/tmp/edit_nb08.py` were both removed from `/tmp` after use, and were never inside the git working tree in the first place).

## Concerns / notes
- The task's suggested markdown text for the new export-step cell literally included the string "ProcessingStep" ("별도 ProcessingStep 없이..."), but the notebook's own verification step requires `grep -c "ProcessingStep"` → 0. I paraphrased that one sentence ("별도의 처리 단계 없이") to preserve the meaning while satisfying the strict zero-count check. All other prose (READMEs, notebook 08) is not covered by that specific zero-count requirement, so I did not need to avoid the word "ProcessingStep" there (I used it once in `pipeline/README.md` to explain why no separate step/container is needed — that file is only checked for `ExportModelForFsx`, which is absent).
- `e2e-workshop/groot/README.md`'s section-5 intro sentence ("...정리하는 후처리까지 자동화하려면...") did not literally contain "ExportModelForFsx", but described the now-inaccurate "후처리(post-processing)" mechanism, so I updated it too for internal consistency, beyond the strictly-grepped set.
- `e2e-workshop/groot/training/scripts/run_training.py:224` still contains a literal `ExportModelForFsx` reference, but that file is teammate's uncommitted work and explicitly out of scope — left untouched by design, and it's a `.py` file so it doesn't affect the `--include=*.md --include=*.ipynb` verification grep.
