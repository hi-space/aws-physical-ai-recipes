# GR00T SageMaker Pipeline

학습 → 모델 등록 → Endpoint 배포까지의 워크플로우를 SageMaker Pipeline 한 번으로 묶어 실행합니다.

## Overview

학습만 한 번 돌릴 때는 [`../training/scripts/run_training.py`](../training/scripts/run_training.py)면 충분하지만, 운영 환경에서는 학습이 끝날 때마다 모델 버전을 기록하고 자동으로 새 endpoint에 반영하고 싶을 때가 많습니다. 이 디렉토리는 그 자동화를 정의합니다.

```
SageMaker Training Job   →   Model Registry 등록   →   Endpoint 배포
   (run_pipeline.py)         (RegisterModel step)      (LambdaStep + lambda_deploy_endpoint.py)
```

학습이 끝나면 `model.tar.gz`가 두 가지로 동시에 흘러갑니다.

- **Model Registry**에 새 버전으로 등록 (이력 관리)
- **Lambda**가 호출되어 같은 이름의 기존 endpoint를 정리하고 새로 배포 (실서빙 갱신)

Lambda는 `create_endpoint` 호출 성공만 확인하고 종료하므로, endpoint가 실제로 `InService`가 될 때까지는 5–10분이 더 걸립니다.

## Project Structure

| 파일 | 역할 |
|------|------|
| `run_pipeline.py` | Pipeline 정의·등록·실행. 학습 step의 인자는 `run_training.py`와 거의 동일 |
| `lambda_deploy_endpoint.py` | LambdaStep이 호출하는 함수. 기존 endpoint 삭제 → Model 생성 → EndpointConfig 생성 → Endpoint 생성을 atomic하게 처리 |

## Getting Started

```bash
cd ../  # groot/
source .venv/bin/activate

# Pipeline 정의 + 실행
python pipeline/run_pipeline.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 6000 --save-steps 2000

# 정의만 업서트 (실행 X)
python pipeline/run_pipeline.py --upsert-only

# 같은 정의 재실행
python pipeline/run_pipeline.py --start-only
```

## Configuration

기본값은 상위 `config.yaml`에서 읽고 CLI 옵션이 우선합니다. 자주 쓰는 옵션:

| 옵션 | 설명 |
|------|------|
| `--dataset-s3-uri` / `--hf-dataset-id` | 학습 데이터 소스 |
| `--max-steps`, `--save-steps`, `--instance-type`, `--num-gpus` | 학습 옵션 (run_training.py와 동일) |
| `--endpoint-name`, `--endpoint-instance-type` | 배포할 endpoint 정보 |
| `--use-spot` / `--no-spot` | Spot 사용 여부 |
| `--groot-version` | `n1.6` 또는 `n1.7` |

## Approval Workflow

기본은 `Approved` 상태로 등록되어 LambdaStep이 즉시 배포할 수 있도록 합니다.

수동 승인 흐름이 필요하면 `run_pipeline.py`의 `RegisterModel` 호출에서 `approval_status`를 `PendingManualApproval`로 바꾸세요. 이후 콘솔의 Model Registry 또는 다음 명령으로 승인합니다:

```bash
aws sagemaker update-model-package \
    --model-package-arn <ARN> --model-approval-status Approved
```

## See Also

- 학습 컨테이너 / 환경변수 상세: [`../training/README.md`](../training/README.md)
- Endpoint 호출 검증: [`../inference/sagemaker/README.md`](../inference/sagemaker/README.md)
- Lambda 함수 인프라 정의: [`../../infra/groot/lambda/`](../../infra/groot/lambda/)
