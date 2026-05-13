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

`infra/`(AWS CDK / TypeScript)가 다음을 생성합니다:
- S3 버킷 (datasets, models, output, checkpoints)
- IAM 역할 (SageMaker 실행, CodeBuild 서비스, Notebook, DeployEndpoint Lambda)
- ECR 리포지토리 2개 (`groot-n16-training`, `groot-n16-inference`)
- CodeBuild 프로젝트 2개
- SSM 파라미터 (`/groot/hf-token`, `/groot/wandb-key`) — 계정 공유
- CloudWatch 로그 그룹
- SageMaker Studio 도메인 + 기본 사용자 프로필
- SageMaker managed **MLflow tracking server** (`groot-mlflow[-{alias}]`)
- Pipeline LambdaStep용 endpoint 배포 Lambda

학습은 SageMaker Training Job(또는 Pipeline) → Model Registry → Endpoint 흐름.

> **여러 사용자/환경에서 같은 계정에 동시 배포** 시 리소스 이름 충돌을 막으려면 `--alias <id>`를 지정하세요 (Step 1 참고). alias가 모든 리소스 이름에 `-<alias>` postfix로 붙고, 스택 이름은 `GrootSMTrainingJob-<alias>`가 됩니다. SSM 파라미터(`/groot/*`)는 계정 공유로 그대로 사용합니다.

---

## 사전 요구사항

| 도구 | 버전 |
|------|------|
| AWS CLI | v2 이상 |
| Python | 3.10 이상 |
| [uv](https://docs.astral.sh/uv/) | 최신 |
| Node.js | 20 이상 (CDK용) |
| AWS CDK | 2.180 이상 |
| Git | 최신 |

Python 의존성은 `pyproject.toml` + `uv.lock`으로 관리됩니다. uv가 자동으로 Python 3.10을 격리 환경(`.venv`)에 맞춰 줍니다.

```bash
# uv 미설치 시
curl -LsSf https://astral.sh/uv/install.sh | sh

cd training/groot-sagemaker
uv sync                       # .venv 생성 + lock 기반 동기화
source .venv/bin/activate     # 이후 모든 'python ...' 명령은 venv에서

aws configure   # 또는 환경변수
```

> 가상환경 활성화 없이 호출하려면 `python` 대신 `uv run python ...`을 쓰면 됩니다.

CDK 의존성은 `infra/package.json`으로 관리됩니다.

```bash
cd infra
npm install
# (계정/리전 첫 사용 시) CDK bootstrap
npx cdk bootstrap aws://<account-id>/<region>
cd ..
```

---

## Step 1: AWS 인프라 배포

CDK(TypeScript)로 배포합니다. `infra/` 디렉터리에서 모든 명령을 실행하세요.

```bash
cd infra

# 단일 사용자 (스택 이름 기본값: GrootSMTrainingJob)
npx cdk deploy \
    -c bucketName=<전 세계 고유 버킷 이름> \
    -c region=us-east-1

# 배포 후 CFN outputs을 ../config.yaml로 갱신
npx ts-node bin/update-config.ts
```

> CDK 컨텍스트 값은 `-c key=value` 또는 `cdk.context.json`으로 전달합니다.

### 멀티 사용자 / 동일 계정 충돌 방지 (`alias`)

같은 AWS 계정에 두 명 이상이 배포하거나, 한 사람이 여러 환경(dev/staging)을 분리해 운용하려면 `alias` 컨텍스트를 지정하세요. 모든 리소스 이름에 `-<alias>` postfix가 붙고 스택 이름은 `GrootSMTrainingJob-<alias>`가 됩니다.

```bash
cd infra

npx cdk deploy \
    -c alias=alice \
    -c bucketName=my-groot-artifacts-alice \
    -c region=us-east-1

npx ts-node bin/update-config.ts --alias alice
```

생성되는 이름 예시 (alias=alice 기준):
- ECR: `groot-n16-training-alice`, `groot-n16-inference-alice`
- IAM: `GR00TSageMakerRole-alice`, `GR00TCodeBuildRole-alice`
- CodeBuild: `groot-n16-training-build-alice`, `groot-n16-inference-build-alice`
- SageMaker Endpoint: `groot-n16-endpoint-alice`
- Model Package Group: `groot-n16-models-alice`
- SageMaker Pipeline: `groot-n16-finetuning-alice`

> SSM 파라미터(`/groot/hf-token`, `/groot/wandb-key`)는 CDK 스택이 만들지 않습니다 — 같은 계정 안에서 모두가 공유합니다. 아래 (선택) 단계로 직접 등록하세요.

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

## 학습 모니터링 (CloudWatch + MLflow)

### CloudWatch metric — Training Job 콘솔의 *Performance* 탭

`scripts/run_training.py` / `pipeline/run_pipeline.py`는 Estimator에 `metric_definitions`을 자동으로 주입합니다. HF Trainer가 stdout으로 출력하는 dict 로그(`{'loss': ..., 'grad_norm': ..., 'learning_rate': ...}`)를 정규식으로 파싱하여 CloudWatch에 발행:

| Metric | 의미 |
|---|---|
| `train:loss` | 학습 step loss |
| `train:grad_norm` | gradient norm |
| `train:learning_rate` | 현재 LR |
| `train:epoch` | 진행도 |
| `eval:loss` / `eval:runtime` | (eval step 활성화 시) |

발행된 metric은 SageMaker Console → Training Jobs → 해당 job의 *Performance* 차트, 또는 CloudWatch Metrics → `/aws/sagemaker/TrainingJobs` namespace에서 조회.

### MLflow tracking — run/metric/param/artifact 풍부 추적

CDK 스택이 SageMaker managed MLflow tracking server(`groot-mlflow[-{alias}]`, Small ≈ $0.64/hr always-on)를 생성하고, `infra/bin/update-config.ts`가 ARN을 `config.yaml`의 `mlflow.tracking_server_arn`에 기록합니다. 학습 스크립트는 이 ARN을 컨테이너 env (`MLFLOW_TRACKING_URI` / `MLFLOW_EXPERIMENT_NAME` / `HF_MLFLOW_LOG_ARTIFACTS=true`)로 자동 주입.

> **GR00T 특이사항**: GR00T `experiment.py`가 `report_to="wandb" if use_wandb else "none"`로 하드코딩하여 MLflow callback이 자동 등록되지 않습니다. 이를 우회하려고 `container/training/sitecustomize.py`가 `transformers.TrainingArguments.__post_init__`을 monkey-patch하여 `MLFLOW_TRACKING_URI`가 설정되어 있으면 `report_to`에 `mlflow`를 강제 추가합니다. (Script Mode로 자동 주입되므로 Docker 재빌드 불필요.)

**MLflow UI 접속:**

```bash
aws sagemaker create-presigned-mlflow-tracking-server-url \
    --tracking-server-name groot-mlflow-yoo \
    --query AuthorizedUrl --output text
```

발급된 URL을 브라우저에 붙여 넣으면 experiment `groot-n16-finetune` 아래 run 별로 metric/param 233개+ / artifact (checkpoint safetensors + DeepSpeed optimizer states) 확인 가능. S3 backing store는 `s3://<bucket>/mlflow-artifacts/`.

**비용 절감 — 안 쓸 때 정지:**

```bash
aws sagemaker stop-mlflow-tracking-server --tracking-server-name groot-mlflow-yoo
# 다시 사용
aws sagemaker start-mlflow-tracking-server --tracking-server-name groot-mlflow-yoo
```

**대안 — Weights & Biases:** SSM `/groot/wandb-key`에 wandb API 키를 넣고 `--wandb-api-key ssm:/groot/wandb-key`를 학습 명령에 추가하면 wandb로도 동시 로깅 가능 (MLflow와 wandb가 둘 다 켜짐).

---

## Step 6: 모델 승인 (Pipeline 사용 시)

콘솔: SageMaker → Model Registry → groot-n16-models[-{alias}] → 최신 버전 → Update Status → Approved

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
cd infra
# alias 미사용 시
npx cdk destroy
# alias 사용 시
npx cdk destroy -c alias=<alias> -c bucketName=<bucket>
```

---

## Custom Robot 사용

다른 로봇으로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 준비 (`meta/modality.json`, `meta/info.json`, `data/`).
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)` 호출.
3. 데이터셋 업로드: `python data/upload_dataset.py --local-path ./my-dataset --prefix datasets/my-robot`
4. 학습: `python scripts/run_training.py --dataset-s3-uri s3://.../my-robot --embodiment-tag NEW_EMBODIMENT`

GR00T 내장 embodiment(`LIBERO_PANDA` 등) 사용 시 `--embodiment-tag LIBERO_PANDA`로 지정하면 `modality_config.py` 없이 동작합니다.

---

## Validation

검증 환경: us-east-1, GR00T N1.6, `LightwheelAI/leisaac-pick-orange`, 100 step.

| 검증 단계 | 결과 |
|---|---|
| Batch 베이스라인 (N1.6, 100 step) | ❌ Skipped — 우리 변경 범위 밖. `infra-groot-finetune` 컨테이너의 transformers 버전이 GR00T-N1.6 model_type을 인식하지 못함 (`Gr00tN1d6` not recognized). 이 가이드의 코드 변경과는 무관. |
| CFN deploy + ECR build (training + inference) | ✅ Success. Training 이미지 3 태그 push (`latest`, `n1.6`, commit hash). |
| SageMaker Training Job — S3 채널 | ✅ Completed (job `groot-n16-training-2026-05-12-04-16-10-593`, ml.g5.12xlarge × 1 instance, 4 GPU, batch_size 32, 100 step, 1655s). model.tar.gz 123MB → S3. |
| CloudWatch metric 발행 (`train:loss/grad_norm/learning_rate`) | ✅ Completed. Estimator `metric_definitions` regex가 HF Trainer dict 로그를 정상 파싱. SageMaker Console *Performance* 탭에 곡선 표시. |
| MLflow tracking 연동 (managed server, 100-step run) | ✅ Completed. Run `e4bf6f5a...` FINISHED, metrics 8개(loss/grad_norm/lr/runtime/throughput/total_flos), params 233개, artifact (checkpoint safetensors ~9.9GB + DeepSpeed optim states) 모두 업로드. |
| SageMaker Training Job — HF 직접 다운 | ⚠️ Code path 검증 완료(컨테이너 내부에서 HF 데이터셋 다운로드 성공). 동일 코드 경로라 별도 학습은 cost 절감 위해 skip. |
| Loss 곡선 비교 (Batch vs SM) | ⚠️ Skipped (Batch baseline failed). |
| SM Endpoint 추론 | ⚠️ Endpoint 배포 시도 실패 (CreateEndpoint returned generic service error before container start; CloudWatch 로그 그룹 미생성). 별도 트러블슈팅 필요 — inference 컨테이너 build/start 경로 점검 필요. |
| GR00T N1.7 빌드/학습 | ⚪ Optional, skip. |

**검증 중 발견되어 fix된 코드 결함:**
- buildspec multi-line `docker build` → CodeBuild YAML parser가 거부. 단일 라인으로 변경.
- buildspec echo string의 콜론 → CodeBuild YAML parser가 mapping으로 오인. single-quote로 처리.
- `estimator.fit(inputs={})` → SageMaker `InputDataConfig`가 비어있으면 거부. HF 직접 다운 경로는 `inputs=None`으로 변경.
- `estimator.model_data` 조회가 `--no-wait` 모드에서 KeyError. `--no-wait`이면 skip.
- Estimator에 `entry_point="train.py"` + `source_dir`이 누락되어 SageMaker Training Toolkit이 entry_point 없이 호출 → AttributeError. 명시 추가 (Script Mode).
- Dockerfile `pip install mlflow`이 Ubuntu 22.04 base의 `blinker 1.4` (distutils-installed) 우려로 실패 → `pip install --ignore-installed blinker mlflow sagemaker-mlflow`로 우회.
- GR00T `experiment.py`가 `report_to="wandb" if use_wandb else "none"`로 하드코딩하여 HF Trainer가 MLflowCallback을 자동 등록하지 못함. `container/training/sitecustomize.py`로 `TrainingArguments.__post_init__`을 monkey-patch해 `MLFLOW_TRACKING_URI`가 있으면 `report_to`에 mlflow를 강제 추가.

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
| Performance 탭이 비어있음 | CFN/컨테이너가 stale (구버전) | `cd infra && npx cdk deploy ...` + `python scripts/trigger_build.py --type training`으로 갱신 후 재학습 |
| MLflow UI에 run이 안 보임 | `MLFLOW_TRACKING_URI` 미주입 또는 sitecustomize.py 미적용 | `config.yaml`의 `mlflow.tracking_server_arn` 값 확인 / `container/training/sitecustomize.py` 존재 확인 |
| `MlflowException: Resource ... not found` | tracking server 정지됨 | `aws sagemaker start-mlflow-tracking-server --tracking-server-name groot-mlflow-<alias>` |
| Docker build 실패 `Cannot uninstall blinker 1.4` | Ubuntu 22.04 base의 distutils blinker | Dockerfile에 `--ignore-installed blinker` 옵션 (이미 적용됨) |

---

## References

- [Isaac-GR00T Repository](https://github.com/NVIDIA/Isaac-GR00T)
- [GR00T N1.6 모델](https://huggingface.co/nvidia/GR00T-N1.6-3B)
- [GR00T N1.7 모델](https://huggingface.co/nvidia/GR00T-N1.7-3B)
- [LightwheelAI/leisaac-pick-orange 데이터셋](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange)
- [Batch 워크숍 가이드](../../isaac-lab-workshop/infra-groot-finetune/) (`physical-ai-on-aws-guide` 모듈 6)
