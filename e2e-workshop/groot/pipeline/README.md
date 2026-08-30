# GR00T SageMaker Pipeline

학습과 "FSx용 export"를 SageMaker Pipeline 한 번으로 묶어 실행합니다.

## Overview

학습만 한 번 돌릴 때는 [`../training/scripts/run_training.py`](../training/scripts/run_training.py)면 충분합니다. 이 파이프라인은 학습 잡이 끝에 결과 모델을 **IsaacSim(EC2)이 바로 로드할 수 있는 형태로 S3에 직접 정리**하는 단일 스텝 파이프라인입니다.

```
SageMaker Training Job (train.py가 source에서 직접 export)
 (notebooks/07_*.ipynb)   →  s3://<bucket>/<model.s3_prefix>/<execution-id>/
```

- SageMaker Training Job은 최종 모델을 `model.tar.gz`로 압축해 `s3://<bucket>/output/...`에도 남기지만,
- 학습 잡이 끝에 `export_s3_uri` hyperparameter로 받은 위치로 **압축 해제된 체크포인트 디렉토리**를 직접 업로드해 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`에 배치합니다.
- 이 prefix를 **FSx for Lustre의 Data Repository Association(import 소스)**로 연결하면, IsaacSim EC2가 FSx 마운트 경로에서 tar 해제 없이 모델을 바로 로드할 수 있습니다.
- 별도 ProcessingStep이나 후처리 컨테이너 없이 source에서 바로 내보내므로 재다운로드/재압축해제가 없습니다.

모델 버전·지표 추적은 학습 step에 붙은 **MLflow**(config.yaml의 `mlflow.*`)로 일원화합니다.

## Project Structure

이 디렉토리에는 별도의 export 스크립트가 없습니다. 모델 export는 학습 컨테이너(`../training/container/train.py`)가 `export_s3_uri` hyperparameter를 받아 source에서 직접 수행합니다. Pipeline 정의·등록·실행은 CLI 대신 노트북으로 진행합니다.

## Getting Started

```bash
cd ../  # groot/
./setup-notebooks.sh   # 1회만 실행 (커널·의존성 준비)
```

code-server에서 [`../notebooks/07_sagemaker_pipeline.ipynb`](../notebooks/07_sagemaker_pipeline.ipynb)를 열어 순서대로 셀을 실행하세요. 노트북 안에서 Pipeline 정의·업서트·실행(단일 학습 스텝)을 모두 다룹니다. 자세한 사용법은 [`../notebooks/README.md`](../notebooks/README.md).

## Configuration

기본값은 상위 `config.yaml`에서 읽고 노트북 셀의 파라미터가 우선합니다. 자주 쓰는 옵션:

| 옵션 | 설명 |
|------|------|
| `dataset_s3_uri` / `hf_dataset_id` | 학습 데이터 소스 |
| `max_steps`, `save_steps`, `instance_type`, `num_gpus` | 학습 옵션 (`run_training.py`와 동일) |
| `use_spot` | Spot 사용 여부 |
| `groot_version` | `n1.6` 또는 `n1.7` |

export 대상 prefix는 `config.yaml`의 `model.s3_prefix`(기본 `models/groot-sm`)를 사용합니다.

## FSx for Lustre 연동 (IsaacSim 소비)

1. 파이프라인 실행 후 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`에 압축되지 않은 모델 디렉토리가 생성됩니다.
2. 이 prefix를 import 소스로 하는 FSx for Lustre 파일시스템(또는 DRA)을 생성합니다.
3. IsaacSim EC2에서 해당 FSx를 마운트하면 마운트 경로에서 모델을 바로 로드할 수 있습니다.

## See Also

- 학습 컨테이너 / 환경변수 상세: [`../training/README.md`](../training/README.md)
- 시뮬레이션 closed-loop 평가(ZMQ Policy Server): [`../inference/README.md`](../inference/README.md)
