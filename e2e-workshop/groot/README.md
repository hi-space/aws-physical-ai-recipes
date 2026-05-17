# GR00T VLA Fine-tuning & Inference

NVIDIA GR00T Vision-Language-Action 모델을 AWS SageMaker로 fine-tuning하고 실시간 추론 엔드포인트로 배포하는 코드 모음입니다.

## Overview

GR00T는 카메라 영상과 자연어 명령("오렌지를 집어라")을 입력으로 받아 로봇 관절을 직접 제어하는 3B 파라미터 Foundation Model입니다. 이 디렉토리의 코드는 GR00T 베이스 모델을 가져와 **자기 로봇 데이터셋에 맞게 파인튜닝하고**, 결과 모델을 **REST API 엔드포인트로 띄워** 실제 로봇 또는 시뮬레이터에서 호출할 수 있게 해줍니다.

세 디렉토리는 다음 흐름으로 연결됩니다.

```
데이터셋 → training/ → 학습된 모델 → pipeline/ → Model Registry → inference/sagemaker/ → 실시간 endpoint
                                                                                   └─→ 로봇/시뮬레이터에서 호출
```

## Prerequisites

이 코드를 실행하려면 인프라가 먼저 배포되어 있어야 합니다. [`../infra/groot/`](../infra/groot/)의 CDK 스택이 다음을 제공합니다:

- 학습/추론 컨테이너를 빌드하는 ECR + CodeBuild
- 학습 잡이 사용할 AWS Batch GPU 환경
- 모델 아티팩트를 저장할 S3 버킷
- 실행 권한을 가진 IAM 역할
- 학습 곡선을 보는 MLflow tracking server
- 학습된 모델을 자동 배포하는 Lambda

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

CodeBuild가 학습/추론 이미지를 만들도록 트리거합니다:

```bash
python training/scripts/trigger_build.py --type all
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

본격 학습은 `--max-steps 6000 --instance-type ml.g6e.12xlarge --num-gpus 4`처럼 키워서 실행하면 됩니다.

학습 곡선은 SageMaker 콘솔의 *Performance* 탭과 MLflow에서 확인할 수 있습니다.

### 5) 엔드포인트 배포 + 호출

```bash
python inference/sagemaker/deploy_endpoint.py

python inference/sagemaker/invoke_endpoint.py \
    --image-path inference/sagemaker/sample/test.png \
    --proprioception "single_arm:0.1,0.2,0.3,0.4,0.5;gripper:0.0" \
    --instruction "pick up the orange"
```

응답으로 16-step의 미래 관절 명령이 나옵니다. 로봇/시뮬레이터에서 매 스텝마다 새 관측값으로 호출하는 receding horizon 방식으로 사용하세요.

### 6) Pipeline으로 한 번에 (선택)

학습부터 endpoint 배포까지 자동화하려면:

```bash
python pipeline/run_pipeline.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange
```

내부적으로 Train → Model Registry 등록 → Lambda를 통한 Endpoint 배포가 순차/병렬로 진행됩니다.

## Project Structure

```
groot/
├── config.yaml          모든 스크립트가 공유하는 설정 (CDK가 채워줌)
├── pyproject.toml       단일 venv 정의 — `uv sync` 한 번이면 환경 준비
├── training/            모델 학습
├── pipeline/            학습 → 모델 등록 → 배포까지 한 번에 도는 SageMaker Pipeline
└── inference/           추론 (SageMaker Endpoint 또는 ZMQ Policy Server)
    ├── sagemaker/
    └── batch-zmq/
```

## Inference Backends

| 백엔드 | 언제 쓰나 |
|--------|-----------|
| [`inference/sagemaker/`](./inference/sagemaker/) | Fine-tune된 모델을 HTTPS REST API로 운영. 다중 클라이언트, 로깅, 오토스케일링이 필요할 때 |
| [`inference/batch-zmq/`](./inference/batch-zmq/) | DCV 인스턴스에서 GR00T base 모델을 빠르게 ping해 서버가 살아있는지 확인. ZMQ Policy Server 형태이므로 Isaac Sim과 closed-loop 연결도 가능 |

## Custom Robot

기본 시나리오는 SO-101이지만, 다른 로봇 데이터로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 준비 (`meta/modality.json` 포함)
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)` 호출
3. `--embodiment-tag NEW_EMBODIMENT`로 학습

GR00T 내장 임베디먼트(`LIBERO_PANDA`, `OXE_DROID` 등)를 쓸 때는 `--embodiment-tag LIBERO_PANDA`만 지정하면 됩니다.

## See Also

- [`training/README.md`](./training/README.md) — 학습 컨테이너와 옵션
- [`pipeline/README.md`](./pipeline/README.md) — SageMaker Pipeline 동작
- [`inference/README.md`](./inference/README.md) — 추론 백엔드 비교
- [`../infra/groot/`](../infra/groot/) — 이 코드를 받쳐주는 CDK 인프라
