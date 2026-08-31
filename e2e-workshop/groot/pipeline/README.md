# GR00T SageMaker Pipeline

데이터 준비 → 학습 → 스모크 검증 → 게이트 → 모델 등록을 SageMaker Pipeline 한 번으로 묶어 실행합니다.

## Overview

학습만 한 번 돌릴 때는 [`../training/scripts/run_training.py`](../training/scripts/run_training.py)면 충분합니다. 이 파이프라인은 그 앞뒤로 데이터 준비와 sanity 검증, 통과한 모델만 Model Registry에 등록하는 게이트를 추가한 **5노드 파이프라인**입니다.

```
TransformDataset → GR00TFinetune → SmokeEval → SmokeGate ─┬─(pass)→ RegisterModel(Approved)
                                                            └─(fail)→ FailStep
```

- **TransformDataset** (`ProcessingStep`) — HF 데이터셋을 다운로드하고 필요 시 v3→v2.1 변환 후 검증·staging합니다. 기존에 노트북/CLI에서 수동으로 하던 데이터셋 업로드 준비 단계를 이 스텝이 흡수합니다.
- **GR00TFinetune** (`TrainingStep`) — 기존 학습 컨테이너(`../training/container/train.py`)를 그대로 사용합니다. TransformDataset의 출력을 학습 입력 채널로 받습니다.
- **SmokeEval** (`ProcessingStep`) — 학습된 체크포인트를 오프라인으로 로드해 `get_action` 추론이 유효한 shape/finite 값을 내는지만 확인합니다.
- **SmokeGate** (`ConditionStep`) — SmokeEval 결과(`evaluation.json`의 `smoke.passed`)를 보고 분기합니다. **품질 지표(정확도 등)를 보는 게이트가 아니라, 모델이 로드되고 추론이 되는지를 보는 sanity + governance 게이트**입니다. 통과하면 `RegisterModel` 스텝이 Model Registry에 **Approved** 상태로 등록하고, 실패하면 `FailStep`으로 파이프라인 실행이 실패합니다.

  > 참고: **첫 실전 파이프라인 실행**에서 SmokeGate가 실패하면 모델 품질보다는 `smoke_eval.py`의 UNVERIFIED 가정(정책 import 경로, observation/action 스키마 등)이 틀렸을 가능성이 더 높습니다. `evaluation.json`의 `smoke.error`를 확인하세요 — `LOAD_OR_INFER_FAILURE:` 접두사면 스파이크 가정 문제이고, 접두사 없이 `action_shape`가 채워져 있으면 실제 shape 불일치입니다.

한편, 학습 잡이 끝에 `train.py`가 `export_s3_uri` hyperparameter로 받은 위치로 압축 해제된 체크포인트를 S3에 직접 내보내는 동작(아래 FSx 연동 섹션)은 **SmokeGate와 독립적으로** 항상 수행됩니다 — 즉 게이트를 통과하지 못해 Model Registry에 등록되지 않아도 S3/FSx 쪽 export 자체는 이미 끝나 있을 수 있습니다. 소비 파이프라인(IsaacSim 등)에서 "게이트를 통과한 모델만 쓴다"는 보장이 필요하면 Model Registry의 Approved 상태를 기준으로 판단해야 합니다.

모델 버전·지표 추적은 학습 step에 붙은 **MLflow**(config.yaml의 `mlflow.*`)로 일원화합니다.

## Project Structure

| 파일 | 역할 |
|------|------|
| `build_pipeline.py` | 위 5개 스텝을 `Pipeline` 객체로 배선하는 순수 함수(`build_pipeline(...)`). Pipeline 정의·등록·실행은 CLI 대신 노트북(`../notebooks/07_sagemaker_pipeline.ipynb`)에서 이 함수를 호출해 진행합니다. |
| `smoke_eval.py` | SmokeEval 스텝의 엔트리포인트. 체크포인트를 로드해 추론 sanity만 확인하고 `evaluation.json`을 남깁니다(위 SmokeGate 설명 참고). |

데이터셋 다운로드/변환/검증 로직(`transform_dataset.py`)은 `../training/data/`에 있으며, TransformDataset 스텝이 이를 호출합니다.

## Getting Started

```bash
cd ../  # groot/
./setup-notebooks.sh   # 1회만 실행 (커널·의존성 준비)
```

code-server에서 [`../notebooks/07_sagemaker_pipeline.ipynb`](../notebooks/07_sagemaker_pipeline.ipynb)를 열어 순서대로 셀을 실행하세요. 노트북 안에서 Model Package Group 생성, `build_pipeline` 호출을 통한 Pipeline 정의·업서트, 실행(5스텝)까지 모두 다룹니다. 별도의 데이터셋 업로드 준비 단계는 없습니다 — TransformDataset 스텝이 그 역할을 흡수합니다. 자세한 사용법은 [`../notebooks/README.md`](../notebooks/README.md).

## Configuration

기본값은 상위 `config.yaml`에서 읽고 노트북 셀의 파라미터가 우선합니다. 자주 쓰는 옵션:

| 옵션 | 설명 |
|------|------|
| `dataset.hf_dataset_id` | TransformDataset이 다운로드할 HF 데이터셋 ID |
| `transform.instance_type` | TransformDataset 스텝 인스턴스 타입 |
| `training.max_steps`, `save_steps`, `instance_type`, `num_gpus` | 학습 옵션 (`run_training.py`와 동일) |
| `eval.instance_type` | SmokeEval 스텝 인스턴스 타입 |
| `model.package_group_name` | RegisterModel이 등록할 Model Package Group 이름 |
| `use_spot` | Spot 사용 여부 |
| `groot_version` | `n1.6` 또는 `n1.7` |

export 대상 prefix는 `config.yaml`의 `model.s3_prefix`(기본 `models/groot-sm`)를 사용합니다.

## Model Registry (SmokeGate 통과 시)

- SmokeGate를 통과한 실행은 `RegisterModel` 스텝에서 `config.yaml`의 `model.package_group_name`(기본 `groot-sm-models`) Model Package Group에 **Approved** 상태로 모델을 등록합니다.
- SageMaker 콘솔의 **Model Registry** 탭에서 등록된 버전과 승인 상태를 확인할 수 있습니다.
- 실패한 실행은 `FailStep`으로 파이프라인 자체가 실패 처리되며, Model Registry에는 아무것도 등록되지 않습니다.

## FSx for Lustre 연동 (IsaacSim 소비)

FSx export는 학습 스텝(`GR00TFinetune`)이 매 실행마다 SmokeGate 결과와 무관하게 수행합니다.

1. 파이프라인 실행 후 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`에 압축되지 않은 모델 디렉토리가 생성됩니다.
2. 이 prefix를 import 소스로 하는 FSx for Lustre 파일시스템(또는 DRA)을 생성합니다.
3. IsaacSim EC2에서 해당 FSx를 마운트하면 마운트 경로에서 모델을 바로 로드할 수 있습니다.
4. "게이트를 통과한 모델만" 마운트하려면 위 Model Registry의 Approved 상태를 execution-id와 대조해 확인하세요.

## See Also

- 학습 컨테이너 / 환경변수 상세: [`../training/README.md`](../training/README.md)
- 데이터셋 다운로드·변환·검증(TransformDataset이 호출하는 로직): [`../training/data/transform_dataset.py`](../training/data/transform_dataset.py)
- 시뮬레이션 closed-loop 평가(ZMQ Policy Server): [`../inference/README.md`](../inference/README.md)
