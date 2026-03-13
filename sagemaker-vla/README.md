# GR00T-N1.6 SageMaker 파인튜닝 및 배포

NVIDIA GR00T-N1.6-3B Vision-Language-Action(VLA) 모델을 AWS SageMaker에서 파인튜닝하고 배포하기 위한 코드 및 가이드를 제공합니다.

## 주요 기능

- **커스텀 Docker 컨테이너** — CUDA 12.4, PyTorch, flash-attn, Isaac-GR00T 의존성을 포함한 학습/추론 컨테이너
- **SageMaker Training Job 런처** — LeRobot v2 데이터셋으로 파인튜닝 실행
- **SageMaker Endpoint 배포** — 파인튜닝된 모델을 실시간 추론 서비스로 배포
- **인스턴스 추천** — 학습/추론 목적별 인스턴스 타입 및 비용 가이드
- **종합 가이드 문서** — 환경 설정부터 배포까지 단계별 안내

## 빠른 시작

### 1. 컨테이너 빌드 및 ECR 푸시

```bash
# 학습용 컨테이너 (account-id, region은 aws configure에서 자동 감지)
bash scripts/build_and_push.sh --type training

# 추론용 컨테이너
bash scripts/build_and_push.sh --type inference
```

### 2. 파인튜닝 실행

```bash
python scripts/launch_training.py \
    --base-model-s3-uri s3://bucket/models/groot-n16 \
    --dataset-s3-uri s3://bucket/datasets/lerobot-v2 \
    --output-s3-uri s3://bucket/output/finetuned \
    --embodiment-tag my_robot \
    --container-image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/groot-training:latest \
    --role-arn arn:aws:iam::123456789:role/SageMakerRole
```

### 3. 엔드포인트 배포

```bash
python scripts/deploy_endpoint.py --action deploy \
    --model-s3-uri s3://bucket/output/finetuned/model.tar.gz \
    --instance-type ml.g5.2xlarge \
    --endpoint-name groot-inference \
    --container-image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/groot-inference:latest \
    --role-arn arn:aws:iam::123456789:role/SageMakerRole
```

### 4. 엔드포인트 호출

```bash
python scripts/invoke_endpoint.py \
    --endpoint-name groot-inference \
    --image-path /path/to/image.png \
    --proprioception 0.1,0.2,0.3,0.4,0.5,0.6,0.7 \
    --instruction "pick up the red block"
```

자세한 내용은 **[guide/GUIDE.md](guide/GUIDE.md)** 를 참고하세요.

## 프로젝트 구조

```
sagemaker-vla/
├── docker/
│   ├── Dockerfile.training        # 학습용 컨테이너
│   └── Dockerfile.inference       # 추론용 컨테이너
├── scripts/
│   ├── build_and_push.sh          # ECR 빌드/푸시 스크립트
│   ├── launch_training.py         # SageMaker Training Job 런처
│   ├── deploy_endpoint.py         # SageMaker Endpoint 배포/삭제
│   └── invoke_endpoint.py         # 엔드포인트 호출 예제
├── src/
│   ├── config.py                  # 설정, 인스턴스 추천, 유효성 검증
│   ├── train_entry.py             # 컨테이너 내 학습 엔트리포인트
│   └── inference_handler.py       # 추론 핸들러 (model_fn, input_fn, predict_fn, output_fn)
├── guide/
│   └── GUIDE.md                   # 종합 가이드 문서 (한국어)
├── tests/                         # 유닛 테스트 및 프로퍼티 테스트
└── README.md
```

## 요구사항

- Python 3.10+
- AWS CLI (설정 완료)
- Docker
- AWS 계정 (SageMaker, ECR, S3 권한)

## 라이선스

이 프로젝트의 라이선스 정보는 리포지토리 루트의 LICENSE 파일을 참고하세요.