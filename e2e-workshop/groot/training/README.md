# GR00T Training

NVIDIA GR00T VLA 모델을 SageMaker Training Job으로 fine-tuning하기 위한 코드입니다. 학습용 Docker 이미지 정의, 데이터셋 준비, SageMaker Estimator로 학습 시작까지를 담당합니다.

## Overview

세 가지 주된 작업을 처리합니다.

1. **학습 이미지 빌드** — `container/`의 Dockerfile을 CodeBuild로 빌드해 ECR에 push
2. **데이터셋 준비** — HuggingFace 데이터셋이나 로컬 데이터를 LeRobot v2.1 형식으로 정리해 S3에 업로드
3. **학습 실행** — SageMaker Training Job을 시작하고 모니터링

## Project Structure

```
training/
├── container/    학습 Docker 이미지를 만드는 코드 (CodeBuild가 빌드)
│   ├── Dockerfile
│   ├── buildspec.yml
│   ├── train.py            SageMaker가 호출하는 학습 entrypoint
│   └── sitecustomize.py    MLflow 로깅 강제 활성화 monkey-patch
├── data/         데이터셋 업로드/변환 유틸과 SO-101용 modality 예시
│   ├── upload_dataset.py
│   ├── convert_v3_to_v2.py
│   ├── download_model.py
│   └── configs/            so101_modality.json, so101_modality_config.py
├── scripts/      학습 시작·이미지 빌드 트리거 스크립트
│   ├── trigger_build.py
│   ├── run_training.py
│   └── build_local.sh
└── tests/
```

## Getting Started

상위 [`groot/`](../) 환경이 준비되어 있다고 가정합니다 (`uv sync` 완료, `config.yaml` 채워짐).

### 컨테이너 빌드

CodeBuild 프로젝트를 시작하고 빌드 종료까지 기다립니다.

```bash
python training/scripts/trigger_build.py --type training     # 학습 이미지 빌드
python training/scripts/trigger_build.py --type training --groot-version n1.7
```

ECR에는 `latest`, 버전(`n1.6`/`n1.7`), commit hash 세 가지 태그로 push됩니다.

### 데이터셋 업로드

```bash
python training/data/upload_dataset.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange
# 또는 로컬 데이터셋
python training/data/upload_dataset.py \
    --local-path ./my-dataset --prefix datasets/my-robot
```

### 학습 실행

기본 인스턴스는 `ml.g6e.12xlarge` (L40S 4-GPU)입니다.

빠른 검증 (100 step):

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 100 --save-steps 50
```

본격 학습:

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 6000 --save-steps 2000
```

단일 GPU로 가볍게 돌리고 싶다면 `--instance-type ml.g5.2xlarge --num-gpus 1` 옵션을 붙이세요.

## Configuration

`run_training.py`의 모든 인자는 상위 `config.yaml`에서 기본값을 읽고, CLI 옵션이 우선합니다.

| 옵션 | 설명 |
|------|------|
| `--dataset-s3-uri` | S3에 업로드된 데이터셋 경로 |
| `--hf-dataset-id` | HF에서 직접 다운로드할 때 (S3 업로드 생략) |
| `--hf-token` | gated 데이터셋·모델용. `ssm:/groot/hf-token`으로 SSM 참조도 가능 |
| `--max-steps`, `--save-steps` | 학습 step 수와 체크포인트 간격 |
| `--instance-type`, `--num-gpus` | 인스턴스 타입과 GPU 개수 |
| `--global-batch-size` | 전체 배치 크기 |
| `--use-spot` / `--no-spot` | Spot Instance 사용 여부 |
| `--groot-version` | `n1.6` 또는 `n1.7` |
| `--embodiment-tag` | 기본 `NEW_EMBODIMENT`. GR00T 내장 임베디먼트면 `LIBERO_PANDA` 등 |

## Training Container

| 파일 | 역할 |
|------|------|
| `Dockerfile` | 학습 이미지 정의. `nvcr.io/nvidia/pytorch` 베이스에 Python 3.10, Isaac-GR00T, transformers, MLflow 설치 |
| `buildspec.yml` | CodeBuild가 위 Dockerfile을 빌드해 ECR로 push하는 절차 |
| `train.py` | SageMaker가 호출하는 학습 entrypoint. SageMaker 환경변수를 파싱해 Isaac-GR00T의 `launch_finetune.py`를 실행하고, 결과 모델을 `SM_MODEL_DIR`에 저장 |
| `sitecustomize.py` | MLflow 로깅을 강제 활성화하는 monkey-patch. GR00T 본체가 `report_to`를 하드코딩해서 HF Trainer의 MLflow callback이 자동 등록되지 않는 문제를 우회 |

## Monitoring

`run_training.py`는 Estimator에 다음을 자동 주입합니다.

- **CloudWatch metric** — HF Trainer가 stdout으로 출력하는 dict 로그(`{'loss': ..., 'grad_norm': ..., 'learning_rate': ...}`)를 정규식으로 파싱해 `train:loss`, `train:grad_norm`, `train:learning_rate`, `train:epoch`로 발행. SageMaker 콘솔의 Training Job *Performance* 탭에서 곡선으로 볼 수 있음
- **MLflow** — `MLFLOW_TRACKING_URI` 환경변수가 컨테이너에 자동 설정. run/metric/param/artifact가 모두 추적됨

MLflow UI는 다음 명령으로 발급한 URL로 접속합니다:

```bash
aws sagemaker create-presigned-mlflow-tracking-server-url \
    --tracking-server-name groot-mlflow-<userId> \
    --query AuthorizedUrl --output text
```

비용을 아끼려면 안 쓸 때 정지하세요:

```bash
aws sagemaker stop-mlflow-tracking-server --tracking-server-name groot-mlflow-<userId>
```

## Custom Robot

기본 시나리오는 SO-101 + `leisaac-pick-orange`이지만, 다른 데이터로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 만들고 `meta/modality.json`을 포함
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)` 호출
3. `python training/data/upload_dataset.py --local-path ./my-dataset --prefix datasets/my-robot`로 업로드
4. `--dataset-s3-uri s3://.../my-robot --embodiment-tag NEW_EMBODIMENT`로 학습

GR00T 내장 임베디먼트는 `meta/modality.json`만 있으면 됩니다.

## See Also

- 학습 → FSx용 export까지 한 번에 자동화: [`../pipeline/`](../pipeline/)
- 시뮬레이션 closed-loop 평가: [`../inference/`](../inference/)
- 인프라 정의: [`../../infra/groot/`](../../infra/groot/)
