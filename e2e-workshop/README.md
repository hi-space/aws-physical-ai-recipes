# Physical AI End-to-End on AWS

AWS 위에서 **로봇 AI 모델을 학습부터 배포·평가까지** 한 번에 굴려볼 수 있는 레시피 모음입니다. NVIDIA Isaac Lab으로 휴머노이드 로봇의 강화학습 정책(RL Policy)을 학습하고, NVIDIA GR00T로 자연어를 이해하는 Vision-Language-Action(VLA) 모델을 fine-tuning한 뒤, 시뮬레이션 환경에서 실제로 로봇을 움직여 검증합니다.

> 단계별 실습 가이드는 별도 문서로 제공됩니다 → **[Physical AI on AWS — End-to-End 워크숍](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop)**

## Overview

실제 로봇으로 AI를 학습시키려면 수백만 번의 시행착오가 필요합니다. 이걸 진짜 로봇으로 하면 시간·비용·안전 모두 부담이 큽니다. 시뮬레이션을 활용하는 **Sim-to-Real** 접근이 표준이지만, GPU 인프라를 직접 세팅하고, 분산 학습 클러스터를 띄우고, 모델을 추론 환경에 배포하는 일은 여전히 무겁습니다.

이 저장소는 그 인프라와 학습/추론 코드를 한 번의 명령으로 띄울 수 있게 묶어둔 것입니다. AWS CDK로 GPU 인스턴스와 공유 FSx for Lustre를 자동 배포하고, SageMaker 학습 환경은 필요한 단계에서 추가로 올립니다. GR00T 학습 컨테이너와 추론 엔드포인트까지 표준화된 형태로 제공합니다.

두 가지 학습 트랙을 다룹니다.

| 트랙 | 설명 | 결과물 |
|------|------|--------|
| **RL Policy** (Isaac Lab) | 휴머노이드 로봇이 거친 지형에서 걷도록 PPO로 학습. 단일 GPU에서 2,048개의 가상 로봇을 동시에 시뮬레이션 | `.pt` 체크포인트 |
| **VLA Foundation Model** (GR00T) | 카메라 영상 + 자연어 명령을 받아 로봇 관절 명령을 직접 생성하는 3B 파라미터 모델을 커스텀 데이터셋으로 fine-tune | S3에 export된 fine-tuned 모델 (FSx for Lustre로 IsaacSim에서 로드) |

두 트랙 모두 같은 기반 인프라(VPC · GPU EC2 · 공유 FSx for Lustre)를 공유합니다.

## Features

- **원클릭 배포** — VPC, GPU EC2(DCV), 공유 FSx for Lustre를 CDK 한 번에 생성. ECR·SageMaker Studio·MLflow는 필요한 트랙에서 추가 배포
- **1인 1계정 모델** — 스택·리소스 식별자에 계정 ID를 자동 사용, 별도 인자 없이 이름이 항상 확정
- **자동 fallback** — GPU 인스턴스 capacity가 부족한 AZ는 Lambda가 자동 탐지해 가용한 곳에 배포
- **MLOps 통합** — 학습 잡이 끝에 source에서 압축 해제된 모델을 S3로 직접 업로드하는 단일-스텝 SageMaker Pipeline, 모델 버전·지표는 MLflow로 추적
- **FSx 연동 소비** — export한 S3 prefix를 FSx for Lustre로 마운트해 IsaacSim(EC2)에서 tar 해제 없이 바로 로드
- **Fleet 모니터링** — 분산 학습 워커들의 Rerun 3D 뷰어와 TensorBoard를 한 화면에서 확인하는 Next.js 대시보드

## Prerequisites

- AWS 계정 (관리자 또는 동등 권한)
- GPU 인스턴스 서비스 할당량 — 배포 리전의 G6/G5 vCPU 한도 확인
- Node.js 18+, AWS CDK CLI
- Python 3.10+ (GR00T 학습 스크립트용 — `uv` 권장)

CloudShell을 사용하면 위 환경이 거의 다 준비되어 있어 가장 편합니다.

## Getting Started

### 1) IsaacLab 인프라 배포

```bash
git clone https://github.com/hi-space/aws-physical-ai-recipes.git
cd aws-physical-ai-recipes/e2e-workshop/infra/isaaclab
npm install

cdk deploy -c region=us-east-1
```

스택 이름은 배포 대상 계정 ID가 붙은 `IsaacLab-Latest-<ACCOUNT_ID>`가 됩니다(1인 1계정 전제).

배포에 70~110분 정도 걸립니다. 대부분은 GPU 인스턴스 안에서 Isaac Sim 이미지(약 20GB)를 받아 Isaac Lab을 빌드하고 데스크톱 환경을 설치하는 시간입니다. 끝나면 출력되는 `DcvUrl`로 접속해 GPU 데스크탑을 사용할 수 있습니다.

### 2) RL 학습 — Isaac Lab으로 휴머노이드 보행

DCV 데스크탑에 접속해서:

```bash
docker run --shm-size=60g --gpus all --rm -it --network=host \
  -e ACCEPT_EULA=Y -e PRIVACY_CONSENT=Y -e DISPLAY \
  isaaclab-batch:latest bash

# 컨테이너 안에서
cd /workspace/IsaacLab
./isaaclab.sh -p scripts/reinforcement_learning/skrl/train.py \
  --task Isaac-Velocity-Rough-H1-v0 --num_envs 2048 --headless
```

### 3) VLA 학습 — GR00T fine-tuning

```bash
# GR00T용 인프라 추가 배포
cd ../../infra/groot
npm install
npm run deploy                        # 단일 스택 GrootFinetune-<ACCOUNT_ID>

# 학습 코드 환경
cd ../../groot
uv sync && source .venv/bin/activate
npx --prefix ../infra/groot ts-node ../infra/groot/bin/update-config.ts \
    --region us-east-1

# 학습 + FSx용 export (Pipeline) — 노트북으로 실행
./setup-notebooks.sh   # 1회만 실행 (커널·의존성 준비)
# code-server에서 notebooks/02_sagemaker_pipeline.ipynb를 열어 순서대로 실행
```

완료 후 `s3://<bucket>/<model.s3_prefix>/<execution-id>/` 에 압축되지 않은 모델이 생성됩니다. 이 prefix를 FSx for Lustre로 마운트해 IsaacSim에서 로드합니다.

## Project Structure

```
e2e-workshop/
├── infra/
│   ├── isaaclab/              IsaacLab CDK 스택 (GPU EC2 + DCV + 공유 FSx)
│   └── groot/                 GR00T VLA CDK 단일 스택 (ECR + CodeBuild + SageMaker + MLflow)
├── groot/                     GR00T 학습 코드 (uv venv)
│   ├── training/              SageMaker 학습 컨테이너 + 트리거 스크립트
│   ├── pipeline/              학습 → FSx용 export 자동화 Pipeline
│   └── inference/
│       └── batch-zmq/         GR00T Policy Server ZMQ ping 클라이언트
├── apps/
│   └── mlops-dashboard/       RL Fleet 모니터링 대시보드 (Next.js)
├── scripts/

└── assets/                    스크린샷
```

각 하위 디렉토리에 자체 README가 있어 더 자세한 사용법과 옵션을 설명합니다.

## Workshop Modules

[워크숍 가이드](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop)가 이 코드베이스를 모듈 단위로 나눠 따라할 수 있게 안내합니다.

| 모듈 | 다루는 내용 | 주로 사용하는 디렉토리 |
|------|-------------|------------------------|
| 1. 인프라 확인 및 환경 접속 | 사전 배포된 GPU 데스크탑(DCV)·code-server 접속 | `infra/isaaclab/` |
| 2. Greengrass base 모델 배포 | GR00T base 모델을 Greengrass 컴포넌트로 시뮬레이션 배포 | `infra/groot/` |
| 3. VLA 인프라 | GR00T용 ECR + SageMaker 확인, base 모델 추론 검증 | `infra/groot/`, `groot/inference/batch-zmq/` · 노트북: `groot/notebooks/01_infra_and_base_check.ipynb` |
| 4. SageMaker 파이프라인 | GR00T fine-tuning + FSx용 export 자동화 | `groot/training/`, `groot/pipeline/` · 노트북: `groot/notebooks/02_sagemaker_pipeline.ipynb` |
| 5. Closed-loop 평가 | LeIsaac으로 fine-tuned 모델을 시뮬레이션에서 평가 | `groot/inference/run-isaaclab.sh` · 노트북: `groot/notebooks/03_closed_loop_eval.ipynb` |
| 6. Greengrass 엣지 배포 | fine-tuned 모델 엣지 배포 (TensorRT) | `infra/groot/` |
| 7-10. RL 트랙 | Isaac Lab 단일 노드 RL → HyperPod 분산 학습 → 정책 검증 | `infra/isaaclab/assets/workshop/`, `../hyperpod-training/` |
| 11. 리소스 정리 | 전체 스택 정리 | — |

## License

이 프로젝트의 라이선스는 저장소 루트 LICENSE 파일을 따릅니다. 사용된 외부 모델·데이터셋(NVIDIA GR00T, Isaac Lab, Cosmos-Reason2-2B, leisaac-pick-orange 등)은 각자의 라이선스를 따릅니다.

## References

- [NVIDIA Isaac Lab](https://isaac-sim.github.io/IsaacLab/)
- [NVIDIA GR00T Foundation Model](https://developer.nvidia.com/gr00t)
- [Isaac-GR00T (GitHub)](https://github.com/NVIDIA/Isaac-GR00T)
- [LeIsaac — Closed-loop 평가 프레임워크](https://github.com/LightwheelAI/leisaac)
