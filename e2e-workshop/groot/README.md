# GR00T VLA Fine-tuning

NVIDIA GR00T Vision-Language-Action 모델을 AWS SageMaker로 fine-tuning하고, 결과 모델을 IsaacSim이 바로 로드할 수 있는 형태로 S3에 정리하는 코드 모음입니다.

## Overview

GR00T는 카메라 영상과 자연어 명령("오렌지를 집어라")을 입력으로 받아 로봇 관절을 직접 제어하는 3B 파라미터 Foundation Model입니다. 이 디렉토리의 코드는 GR00T 베이스 모델을 가져와 **자기 로봇 데이터셋에 맞게 파인튜닝하고**, 결과 모델을 **압축 해제 상태로 S3에 정리해 DCV 인스턴스에서 `aws s3 sync` 한 번으로 IsaacSim에 로드**할 수 있게 합니다.

세 디렉토리는 다음 흐름으로 연결됩니다.

```
HF 데이터셋 ID → pipeline/ (TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel)
                   ├─→ s3://<bucket>/<model.s3_prefix>/<execution-id>/  (train.py가 source에서 직접 export)
                   │       └─→ DCV 인스턴스에서 aws s3 sync → IsaacSim에서 로드
                   └─→ Model Registry (SmokeGate 통과 시 Approved 등록)
```

## Prerequisites

이 코드를 실행하려면 인프라가 먼저 배포되어 있어야 합니다. [`../infra/groot/`](../infra/groot/)의 CDK 스택이 다음을 제공합니다:

- 학습 컨테이너를 빌드하는 ECR + CodeBuild
- 모델 아티팩트를 저장할 S3 버킷
- 실행 권한을 가진 IAM 역할
- 학습 곡선·모델 버전을 추적하는 MLflow tracking server

배포가 끝나면 인프라 정보가 `config.yaml`에 자동으로 채워지고, 이 디렉토리의 모든 스크립트가 그 값을 기본값으로 사용합니다.
`DeploymentProfile` 출력이 `workshop-studio`면 `update-config.ts`가 `transform.instance_type`을 `ml.g5.2xlarge`로 기록한다(Workshop Studio 계정의 processing-job 허용 타입).

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

> **권장 경로인 5) Pipeline을 쓰면 이 단계는 필요 없습니다** — 파이프라인의 TransformDataset 스텝이 HF 다운로드·변환·검증·staging을 대신합니다. 아래는 4)의 단발 CLI 학습이나 로컬 데이터셋을 위한 단계입니다.

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

기본 인스턴스는 `ml.g5.12xlarge` (A10G 4-GPU)입니다. g6e 쿼터가 있으면 `--instance-type ml.g6e.12xlarge`(L40S 4-GPU)로 더 빠르게 학습할 수 있습니다. 본격 학습은 `--max-steps 6000 --save-steps 2000`처럼 step만 키워서 실행하면 됩니다.

학습 곡선(loss/grad_norm/learning_rate, GPU 사용률)은 MLflow에서 봅니다. Studio의 Training Job *Performance* 탭은 `metric_definitions`의 마지막 값만 표로 보여주고, 시계열은 CloudWatch(`/aws/sagemaker/TrainingJobs`)에 남습니다.

### 5) Pipeline으로 학습 + 스모크 게이트 + 모델 등록 (권장)

데이터 준비부터 모델 등록까지 한 번에 도는 5노드 파이프라인입니다 (TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel/FailStep). HF 데이터셋 ID만 지정하면 3)의 업로드 없이 TransformDataset이 다운로드·검증·staging을 대신하고, SmokeGate를 통과한 모델만 Model Registry에 **Approved**로 등록됩니다.

```bash
./setup-notebooks.sh <region>            # 1회만 실행 (커널·의존성·config.yaml 준비)
```

code-server에서 [`notebooks/02_sagemaker_pipeline.ipynb`](./notebooks/02_sagemaker_pipeline.ipynb)를 열어 순서대로 셀을 실행합니다.

학습 스텝은 끝에 압축 해제된 모델을 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`로 직접 업로드합니다 (SmokeGate 결과와 무관하게 항상 수행 — `pipeline/README.md` 참고). DCV 인스턴스에서 이 prefix를 `aws s3 sync`로 받으면 IsaacSim에서 바로 로드할 수 있습니다. 자세한 내용은 [`pipeline/README.md`](./pipeline/README.md), [`notebooks/README.md`](./notebooks/README.md).

### 6) 시뮬레이션에서 검증 (선택)

Fine-tune한 모델이 시뮬레이터 안에서 실제 태스크를 수행하는지 확인하려면 [`inference/`](./inference/)의 closed-loop 평가(`run-isaaclab.sh`)를 사용하세요.

## Project Structure

```
groot/
├── config.yaml          모든 스크립트가 공유하는 설정 (CDK가 채워줌)
├── pyproject.toml       단일 venv 정의 — `uv sync` 한 번이면 환경 준비
├── setup-notebooks.sh   노트북 실행용 커널·의존성 1회 설정 스크립트
├── notebooks/           워크숍 노트북 (05 인프라·베이스 확인 / 07 파이프라인 / 08 closed-loop 평가)
├── training/            모델 학습
├── pipeline/            데이터 준비 → 학습 → 스모크 게이트 → 모델 등록 SageMaker Pipeline
└── inference/           시뮬레이션 closed-loop 평가 (ZMQ Policy Server)
    └── batch-zmq/
```

## 학습 결과 소비

| 경로 | 언제 쓰나 |
|--------|-----------|
| `aws s3 sync` → IsaacSim | 학습 잡이 source에서 직접 업로드한 압축되지 않은 S3 prefix를 DCV 인스턴스 로컬 디스크로 받아 IsaacSim에서 모델을 바로 로드 (기본 경로) |
| [`inference/batch-zmq/`](./inference/batch-zmq/) | DCV 인스턴스에서 GR00T Policy Server를 빠르게 ping해 서버가 살아있는지 확인. Isaac Sim과 closed-loop 연결 가능 |

## Custom Robot

기본 시나리오는 SO-101이지만, 다른 로봇 데이터로 학습하려면:

1. 데이터셋을 LeRobot v2.1 형식으로 준비 (`meta/modality.json` 포함)
2. 데이터셋 root에 `modality_config.py`를 두고 `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)` 호출
3. `--embodiment-tag NEW_EMBODIMENT`로 학습

GR00T 내장 임베디먼트(`LIBERO_PANDA`, `OXE_DROID` 등)를 쓸 때는 `--embodiment-tag LIBERO_PANDA`만 지정하면 됩니다.

## See Also

- [`notebooks/README.md`](./notebooks/README.md) — 워크숍 노트북 실행 가이드
- [`training/README.md`](./training/README.md) — 학습 컨테이너와 옵션
- [`pipeline/README.md`](./pipeline/README.md) — SageMaker Pipeline + 비압축 export
- [`inference/README.md`](./inference/README.md) — 시뮬레이션 closed-loop 평가
- [`../infra/groot/`](../infra/groot/) — 이 코드를 받쳐주는 CDK 인프라
