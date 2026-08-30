# GR00T VLA Fine-tuning

NVIDIA GR00T Vision-Language-Action 모델을 AWS SageMaker로 fine-tuning하고, 결과 모델을 IsaacSim이 바로 로드할 수 있는 형태로 S3에 정리하는 코드 모음입니다.

## Overview

GR00T는 카메라 영상과 자연어 명령("오렌지를 집어라")을 입력으로 받아 로봇 관절을 직접 제어하는 3B 파라미터 Foundation Model입니다. 이 디렉토리의 코드는 GR00T 베이스 모델을 가져와 **자기 로봇 데이터셋에 맞게 파인튜닝하고**, 결과 모델을 **FSx for Lustre로 마운트해 IsaacSim에서 로드**할 수 있도록 S3에 정리합니다.

세 디렉토리는 다음 흐름으로 연결됩니다.

```
데이터셋 → training/ (train.py가 source에서 직접 S3로 export) → s3://<bucket>/<model.s3_prefix>/<execution-id>/
                                                                    └─→ FSx for Lustre 마운트 → IsaacSim에서 로드
```

## Prerequisites

이 코드를 실행하려면 인프라가 먼저 배포되어 있어야 합니다. [`../infra/groot/`](../infra/groot/)의 CDK 스택이 다음을 제공합니다:

- 학습 컨테이너를 빌드하는 ECR + CodeBuild
- 학습 잡이 사용할 AWS Batch GPU 환경
- 모델 아티팩트를 저장할 S3 버킷
- 실행 권한을 가진 IAM 역할
- 학습 곡선·모델 버전을 추적하는 MLflow tracking server

배포가 끝나면 인프라 정보가 `config.yaml`에 자동으로 채워지고, 이 디렉토리의 모든 스크립트가 그 값을 기본값으로 사용합니다.

추가로 Python 3.10+ 와 [`uv`](https://docs.astral.sh/uv/)가 필요합니다.

## Getting Started

### 1) 환경 준비

```bash
cd e2e-workshop/groot
uv sync
source .venv/bin/activate
```

### 2) 컨테이너 이미지 빌드

CodeBuild가 학습 이미지를 만들도록 트리거합니다:

```bash
python training/scripts/trigger_build.py --type training
```

flash-attn 등을 포함하므로 약 20–40분 소요됩니다.

### 3) 데이터셋 업로드

워크숍 기본값은 SO-101 로봇으로 오렌지를 집는 [`leisaac-pick-orange`](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange) 데이터셋입니다.

```bash
python training/data/upload_dataset.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange
```

LeRobot v3 형식이면 자동으로 v2.1로 변환됩니다.

### 4) 학습 시작

빠른 검증용 100 step (10–15분):

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 100 --save-steps 50
```

기본 인스턴스는 `ml.g6e.12xlarge` (L40S 4-GPU)입니다. 본격 학습은 `--max-steps 6000 --save-steps 2000`처럼 step만 키워서 실행하면 됩니다.

학습 곡선은 SageMaker 콘솔의 *Performance* 탭과 MLflow에서 확인할 수 있습니다.

### 5) Pipeline으로 학습 + FSx용 export (권장)

학습 잡이 끝에 IsaacSim이 로드할 수 있는 형태로 모델을 S3에 직접 정리하는 단일 스텝 파이프라인을 사용하려면 노트북을 사용하세요:

```bash
./setup-notebooks.sh   # 1회만 실행 (커널·의존성 준비)
```

code-server에서 [`notebooks/07_sagemaker_pipeline.ipynb`](./notebooks/07_sagemaker_pipeline.ipynb)를 열어 순서대로 셀을 실행합니다.

내부적으로 학습 잡이 끝에 source에서 압축 해제된 모델을 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`로 직접 업로드하는 단일 스텝 파이프라인입니다. 이 prefix를 FSx for Lustre로 마운트하면 IsaacSim에서 바로 로드할 수 있습니다. 자세한 내용은 [`pipeline/README.md`](./pipeline/README.md), [`notebooks/README.md`](./notebooks/README.md).

### 6) 시뮬레이션에서 검증 (선택)

Fine-tune한 모델이 시뮬레이터 안에서 실제 태스크를 수행하는지 확인하려면 [`inference/`](./inference/)의 closed-loop 평가(`run-isaaclab.sh`)를 사용하세요.

## Project Structure

```
groot/
├── config.yaml          모든 스크립트가 공유하는 설정 (CDK가 채워줌)
├── pyproject.toml       단일 venv 정의 — `uv sync` 한 번이면 환경 준비
├── setup-notebooks.sh   노트북 실행용 커널·의존성 1회 설정 스크립트
├── notebooks/           워크숍 모듈 5·7·8 노트북
├── training/            모델 학습
├── pipeline/            학습 → FSx용 export까지 도는 SageMaker Pipeline
└── inference/           시뮬레이션 closed-loop 평가 (ZMQ Policy Server)
    └── batch-zmq/
```

## 학습 결과 소비

| 경로 | 언제 쓰나 |
|--------|-----------|
| FSx for Lustre 마운트 → IsaacSim | 학습 잡이 source에서 직접 업로드한 압축되지 않은 S3 prefix를 FSx로 마운트해 IsaacSim에서 모델을 바로 로드 (기본 경로) |
| [`inference/batch-zmq/`](./inference/batch-zmq/) | DCV 인스턴스에서 GR00T Policy Server를 빠르게 ping해 서버가 살아있는지 확인. Isaac Sim과 closed-loop 연결 가능 |

## Custom Robot

기본 시나리오는 SO-101이지만, 다른 로봇 데이터로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 준비 (`meta/modality.json` 포함)
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)` 호출
3. `--embodiment-tag NEW_EMBODIMENT`로 학습

GR00T 내장 임베디먼트(`LIBERO_PANDA`, `OXE_DROID` 등)를 쓸 때는 `--embodiment-tag LIBERO_PANDA`만 지정하면 됩니다.

## See Also

- [`notebooks/README.md`](./notebooks/README.md) — 워크숍 모듈 5·7·8 노트북 실행 가이드
- [`training/README.md`](./training/README.md) — 학습 컨테이너와 옵션
- [`pipeline/README.md`](./pipeline/README.md) — SageMaker Pipeline + FSx용 export
- [`inference/README.md`](./inference/README.md) — 시뮬레이션 closed-loop 평가
- [`../infra/groot/`](../infra/groot/) — 이 코드를 받쳐주는 CDK 인프라
