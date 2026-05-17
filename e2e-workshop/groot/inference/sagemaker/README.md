# GR00T SageMaker Endpoint

Fine-tune한 GR00T 모델을 SageMaker Real-time Endpoint로 띄워 REST API로 호출하기 위한 코드입니다.

## Overview

학습이 끝나면 `model.tar.gz`가 S3에 저장됩니다. 이 디렉토리의 코드는 그 모델을 가져와 다음 작업을 수행합니다.

- 추론용 Docker 컨테이너 빌드 (FastAPI 기반)
- SageMaker Endpoint 생성/삭제
- 이미지 + 자연어 + 관절 상태로 실제 추론 호출

## Project Structure

```
sagemaker/
├── container/
│   ├── Dockerfile           추론 이미지 정의
│   ├── buildspec.yml        CodeBuild 빌드 절차
│   └── serve.py             FastAPI 추론 서버 (GET /ping, POST /invocations)
├── deploy_endpoint.py       Endpoint 생성/삭제
├── invoke_endpoint.py       Endpoint 호출
└── sample/test.png          호출 테스트용 예제 이미지
```

## Inference Server

`serve.py`는 SageMaker Real-time Endpoint 규약을 따르는 FastAPI 앱입니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/ping` | 헬스체크 — 항상 200 OK |
| `POST` | `/invocations` | 추론 요청 처리 |

요청 형식:

```json
{
  "image": "<base64 인코딩된 RGB 이미지>",
  "proprioception": [0.1, 0.2, 0.3, 0.4, 0.5, 0.0],
  "instruction": "pick up the orange"
}
```

응답 형식:

```json
{
  "actions": [[0.05, -0.12, 0.33, ...]],
  "timestamp": "2024-01-15T10:30:00.000000+00:00"
}
```

`actions`는 16-step 미래 관절 명령입니다. 차원과 키는 학습한 데이터셋에 따라 다르며, 서버가 모델 아티팩트의 메타데이터를 읽어 자동으로 결정합니다.

## Getting Started

기본값은 상위 `config.yaml`에서 읽고 CLI 옵션이 우선합니다.

### Endpoint 배포

Model Registry에 등록된 최신 승인 모델을 배포:

```bash
python inference/sagemaker/deploy_endpoint.py
```

특정 model.tar.gz를 직접 지정해 배포:

```bash
python inference/sagemaker/deploy_endpoint.py \
    --model-s3-uri s3://<bucket>/output/<job>/output/model.tar.gz
```

배포는 약 5–10분 걸립니다.

### Endpoint 호출

```bash
python inference/sagemaker/invoke_endpoint.py \
    --image-path inference/sagemaker/sample/test.png \
    --proprioception "single_arm:0.1,0.2,0.3,0.4,0.5;gripper:0.0" \
    --instruction "pick up the orange"
```

### Endpoint 삭제

```bash
python inference/sagemaker/deploy_endpoint.py --action delete
```

## Configuration

### deploy_endpoint.py

| 옵션 | 설명 |
|------|------|
| `--endpoint-name` | 생성할 endpoint 이름 |
| `--instance-type` | 추론 인스턴스 타입 (기본 `ml.g5.2xlarge`) |
| `--model-package-arn` | 특정 Model Package 버전을 명시 |
| `--model-s3-uri` | model.tar.gz 직접 지정 (Registry 우회) |
| `--inference-image-uri` | 추론 컨테이너 ECR URI 직접 지정 |
| `--action` | `deploy` 또는 `delete` |

### invoke_endpoint.py

`proprioception`은 두 가지 형식을 지원합니다.

- **Keyed** (`single_arm:0.1,0.2,...;gripper:0.0`) — SO-101처럼 여러 state 키를 사용하는 모델용 (권장)
- **Flat** (`0.1,0.2,0.3,0.4,0.5,0.0`) — 단일 state 키 모델용

학습한 데이터셋의 modality 정의에 맞춰야 합니다. 잘못된 형식이면 서버가 기대 형식을 에러 메시지로 반환합니다.

## Container Build

추론 이미지는 [`../../training/scripts/trigger_build.py`](../../training/scripts/trigger_build.py)로 빌드합니다.

```bash
python training/scripts/trigger_build.py --type inference
```

빌드된 이미지는 ECR `groot-sm-inference`로 push됩니다.

## Pipeline Integration

[`../../pipeline/run_pipeline.py`](../../pipeline/run_pipeline.py)는 학습이 끝나면 LambdaStep으로 endpoint를 자동 배포합니다. 따라서 보통은 이 디렉토리의 `deploy_endpoint.py`를 직접 호출할 필요가 없고, **수동으로 모델 버전을 바꿔 띄우거나 정리할 때**만 사용합니다.

## See Also

- 학습 컨테이너: [`../../training/`](../../training/)
- Pipeline: [`../../pipeline/`](../../pipeline/)
- Lambda 인프라 정의: [`../../../infra/groot/lambda/`](../../../infra/groot/lambda/)
- 다른 추론 백엔드 (base 모델 ZMQ 검증): [`../batch-zmq/`](../batch-zmq/)
