# GR00T SageMaker 파인튜닝 및 배포 가이드 (SO-101)

## 개요

이 가이드는 NVIDIA GR00T VLA 모델을 AWS SageMaker에서 파인튜닝하고 실시간 추론 엔드포인트로 서빙하는 워크플로우를 단계별로 설명합니다. 기본 시나리오는 **SO-101 로봇 + `LightwheelAI/leisaac-pick-orange` 데이터셋**입니다. 동일한 task가 AWS Batch 위에서도 검증되어 있습니다 (`isaac-lab-workshop/infra-groot-finetune` 참고).

### 데모 시나리오

| 항목 | 내용 |
|------|------|
| **로봇** | [SO-ARM101](https://github.com/TheRobotStudio/SO-ARM100) — 6-DOF 단일 팔 (5 관절 + 그리퍼) |
| **데이터셋** | [`LightwheelAI/leisaac-pick-orange`](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange) |
| **태스크** | 오렌지 집기 (pick and place) |
| **관측** | RGB 카메라 2대 (front, wrist) + 6차원 관절 상태 (single_arm: 5 + gripper: 1) |
| **액션** | 6차원 관절 명령 (single_arm: 5 + gripper: 1) |
| **Embodiment Tag** | `NEW_EMBODIMENT` |
| **GR00T 버전** | N1.6 (기본) 또는 N1.7 |

> 다른 로봇/데이터셋 사용은 "Custom Robot 사용" 섹션 참고.

### 아키텍처

`infra/cloudformation.yaml`이 다음을 생성합니다:
- S3 버킷 (datasets, models, output, checkpoints)
- IAM 역할 (SageMaker 실행, CodeBuild 서비스)
- ECR 리포지토리 2개 (`groot-n16-training`, `groot-n16-inference`)
- CodeBuild 프로젝트 2개
- SSM 파라미터 (`/groot/hf-token`, `/groot/wandb-key`)
- CloudWatch 로그 그룹

학습은 SageMaker Training Job(또는 Pipeline) → Model Registry → Endpoint 흐름.

---

## 사전 요구사항

| 도구 | 버전 |
|------|------|
| AWS CLI | v2 이상 |
| Python | 3.10 이상 |
| Git | 최신 |

```bash
cd training/groot-sagemaker
pip install -r requirements-dev.txt
aws configure   # 또는 환경변수
```

---

## Step 1: AWS 인프라 배포

```bash
python infra/deploy_stack.py \
    --stack-name groot-n16-stack \
    --bucket-name <전 세계 고유 버킷 이름> \
    --region us-east-1
```

`config.yaml`이 자동으로 갱신됩니다.

### (선택) SSM 토큰 설정

```bash
aws ssm put-parameter --name /groot/hf-token \
    --value hf_xxxxxxxxxxxxxxxxxxxx --type SecureString --overwrite

aws ssm put-parameter --name /groot/wandb-key \
    --value <wandb_key> --type SecureString --overwrite
```

---

## Step 2: GR00T 베이스 모델 다운로드 (선택)

```bash
python data/download_model.py
```

이 단계는 SageMaker Training Job이 HF에서 직접 모델을 받도록 하면 생략 가능합니다.

---

## Step 3: 데이터셋 업로드

### Quick start: SO-101 leisaac-pick-orange

```bash
python data/upload_dataset.py --hf-dataset-id LightwheelAI/leisaac-pick-orange
```

> v3 형식 데이터셋은 자동으로 v2.1로 변환됩니다.

### 데이터셋 modality 준비

학습 컨테이너는 데이터셋의 `meta/modality.json`을 읽어 학습합니다. 데이터셋 root에 `modality_config.py`가 있으면 자동 감지하여 `--modality_config_path`로 전달합니다.

`NEW_EMBODIMENT` (커스텀 robot, SO-101 포함)는 두 파일 모두 권장됩니다. 참고용 SO-101 예시:
- `data/configs/so101_modality.json` → 데이터셋의 `meta/modality.json`으로 복사
- `data/configs/so101_modality_config.py` → 데이터셋 root에 `modality_config.py`로 복사

GR00T 내장 embodiment(`LIBERO_PANDA`, `OXE_DROID` 등)는 `meta/modality.json`만 있으면 충분합니다.

---

## Step 4: 컨테이너 빌드 (CodeBuild)

```bash
# 기본 (N1.6)
python scripts/trigger_build.py --type all

# N1.7로 빌드 (CFN 재배포 없이)
python scripts/trigger_build.py --type training --groot-version n1.7
```

ECR에 두 태그로 push됩니다:
- `latest` (가장 최근 빌드)
- `n1.6` 또는 `n1.7` (버전별 고정)

빌드 시간: 약 20-40분 (flash-attn pre-built wheel 사용).

CodeBuild 자체는 자동으로 시작되지 않습니다 — 인프라 배포 후 위 명령으로 명시 트리거합니다.

---

## Step 5: 파인튜닝 실행

### Quick validation (100 steps, ~10-15분)

```bash
# S3 채널 (Step 3에서 업로드한 경우):
python scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 100 --save-steps 50

# HF 직접 다운로드 (S3 업로드 생략):
python scripts/run_training.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange \
    --hf-token ssm:/groot/hf-token \
    --max-steps 100 --save-steps 50
```

### 본격 학습 (6000 steps)

```bash
python scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 6000 --save-steps 2000 \
    --instance-type ml.g6e.12xlarge --num-gpus 4
```

### Pipeline (Model Registry 등록 포함)

```bash
python pipeline/run_pipeline.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange
```

### N1.7 사용

N1.7은 `nvidia/Cosmos-Reason2-2B` (HF gated) backbone을 씁니다. HF 토큰 + 라이선스 동의 필수.

```bash
python scripts/trigger_build.py --type training --groot-version n1.7
python scripts/run_training.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange \
    --hf-token ssm:/groot/hf-token \
    --groot-version n1.7
```

---

## Step 6: 모델 승인 (Pipeline 사용 시)

콘솔: SageMaker → Model Registry → groot-n16-models → 최신 버전 → Update Status → Approved

또는 CLI:
```bash
aws sagemaker update-model-package \
    --model-package-arn <ARN> --model-approval-status Approved
```

---

## Step 7: Endpoint 배포

### Model Registry에서 배포

```bash
python scripts/deploy_endpoint.py
```

### S3 URI에서 직접 배포

```bash
python scripts/deploy_endpoint.py \
    --model-s3-uri s3://<bucket>/output/<job>/output/model.tar.gz
```

배포 시간 약 5-10분.

---

## Step 8: 추론 테스트

### SO-101 keyed proprioception (권장)

```bash
python scripts/invoke_endpoint.py \
    --image-path ./sample/test.png \
    --proprioception "single_arm:0.1,0.2,0.3,0.4,0.5;gripper:0.0" \
    --instruction "pick up the orange"
```

값 개수와 키는 **학습한 데이터셋의 `meta/modality.json`에 맞춰야** 합니다. 모델은 `inference_metadata.json`과 `statistics.json`에서 차원을 자동 감지합니다.

### Flat proprioception (단일 state 키 모델)

```bash
python scripts/invoke_endpoint.py \
    --image-path ./sample/test.png \
    --proprioception 0.1,0.2,0.3,0.4,0.5,0.0 \
    --instruction "pick up the orange"
```

---

## Step 9: 정리

```bash
python scripts/deploy_endpoint.py --action delete

aws s3 rm s3://<bucket> --recursive
aws cloudformation delete-stack --stack-name groot-n16-stack
```

---

## Custom Robot 사용

다른 로봇으로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 준비 (`meta/modality.json`, `meta/info.json`, `data/`).
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENG)` 호출.
3. 데이터셋 업로드: `python data/upload_dataset.py --local-path ./my-dataset --prefix datasets/my-robot`
4. 학습: `python scripts/run_training.py --dataset-s3-uri s3://.../my-robot --embodiment-tag NEW_EMBODIMENT`

GR00T 내장 embodiment(`LIBERO_PANDA` 등) 사용 시 `--embodiment-tag LIBERO_PANDA`로 지정하면 `modality_config.py` 없이 동작합니다.

---

## Validation

각 단계의 명령어와 검증 결과는 다음과 같습니다 (Task 14에서 채움):

| 검증 단계 | 결과 |
|---|---|
| Batch 베이스라인 (N1.6, leisaac-pick-orange, 100 step) | <기록 예정> |
| SageMaker Training Job — S3 채널 | <기록 예정> |
| SageMaker Training Job — HF 직접 다운 | <기록 예정> |
| Loss 곡선 비교 (Batch vs SM) | <기록 예정> |
| SM Endpoint 추론 (SM 학습 모델) | <기록 예정> |
| Cross-backend 추론 (Batch 모델 → SM Endpoint) | <기록 예정> |
| GR00T N1.7 빌드/학습 | <기록 예정> |

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `Access to model nvidia/Cosmos-Reason2-2B is restricted` | N1.7 HF_TOKEN 미설정/라이선스 미동의 | HF에서 모델 라이선스 동의 + `--hf-token ssm:/groot/hf-token` 추가 |
| ECR 인증 실패 | 자격증명 만료 | `aws sts get-caller-identity` 확인 |
| CodeBuild 실패 | flash-attn 다운로드 실패 등 | CloudWatch `/aws/codebuild/groot-n16-training-build` 확인 후 재시도 |
| SageMaker Training Job ResourceLimitExceeded | 인스턴스 쿼터 부족 | Service Quotas에서 ml.g5.2xlarge 또는 ml.g6e.xlarge 증가 |
| Endpoint 5xx | model.tar.gz에 inference_metadata.json 누락 | train.py가 자동 저장하므로 학습 로그 확인 |
| 추론 차원 불일치 | proprioception 값 개수 ≠ 모델 기대값 | 에러 메시지에 출력된 keyed 형식대로 호출 |

---

## References

- [Isaac-GR00T Repository](https://github.com/NVIDIA/Isaac-GR00T)
- [GR00T N1.6 모델](https://huggingface.co/nvidia/GR00T-N1.6-3B)
- [GR00T N1.7 모델](https://huggingface.co/nvidia/GR00T-N1.7-3B)
- [LightwheelAI/leisaac-pick-orange 데이터셋](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange)
- [Batch 워크숍 가이드](../../isaac-lab-workshop/infra-groot-finetune/) (`physical-ai-on-aws-guide` 모듈 6)
