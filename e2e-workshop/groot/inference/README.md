# GR00T Inference

GR00T 모델로 실제 추론 요청을 보내는 두 가지 경로와 시뮬레이션 closed-loop 평가 진입점을 제공합니다.

## Overview

```
inference/
├── sagemaker/         Fine-tune된 모델을 HTTPS REST API로 운영
├── batch-zmq/         GR00T base 모델 ZMQ 추론 서버 ping 클라이언트 (디버깅·검증용)
└── run-isaaclab.sh    Isaac Lab + LeIsaac으로 closed-loop 시뮬레이션 평가
```

상황별 선택:

| 상황 | 사용할 경로 |
|------|-------------|
| 파이프라인으로 학습한 SO-101 모델을 운영 환경에 배포해 호출하고 싶다 | [`sagemaker/`](./sagemaker/) |
| DCV 인스턴스에서 GR00T base 모델 서버가 살아있는지 빠르게 확인하고 싶다 | [`batch-zmq/`](./batch-zmq/) |
| Fine-tune한 모델로 시뮬레이터 안에서 로봇이 실제 태스크를 수행하는지 평가하고 싶다 | `run-isaaclab.sh` |

## SageMaker Endpoint

SageMaker Real-time Endpoint로 모델을 띄우고 REST로 호출합니다. 다중 클라이언트와 오토스케일링이 필요한 운영 시나리오에 적합합니다.

```bash
cd ..  # groot/
source .venv/bin/activate

# 배포
python inference/sagemaker/deploy_endpoint.py

# 호출
python inference/sagemaker/invoke_endpoint.py \
    --image-path inference/sagemaker/sample/test.png \
    --proprioception "single_arm:0.1,0.2,0.3,0.4,0.5;gripper:0.0" \
    --instruction "pick up the orange"

# 정리
python inference/sagemaker/deploy_endpoint.py --action delete
```

응답으로는 16-step의 미래 관절 명령이 돌아옵니다. 자세한 옵션은 [`sagemaker/README.md`](./sagemaker/README.md).

## Batch ZMQ Client

GR00T 공식 추론 서버(`run_gr00t_server.py`)는 ZMQ REQ/REP 소켓으로 동작합니다. 이 디렉토리의 작은 클라이언트는 그 서버에 ping을 보내고 더미 observation 한 번을 inference 해서 서버가 정상인지 빠르게 검증합니다.

```bash
cd batch-zmq
uv run python test_inference.py                       # 같은 머신
uv run python test_inference_remote.py <INSTANCE_IP>  # 원격
```

GR00T base 모델(GR1 임베디먼트) 검증용 더미 데이터를 사용하므로 fine-tune 결과 검증은 SageMaker Endpoint나 시뮬레이션 평가를 쓰세요. 자세한 프로토콜은 [`batch-zmq/README.md`](./batch-zmq/README.md).

## Closed-loop Evaluation (`run-isaaclab.sh`)

DCV 인스턴스에서 호출하는 bash 스크립트. Isaac Lab 컨테이너 안에서 [LeIsaac](https://github.com/LightwheelAI/leisaac) 패키지를 설치하고, SO-101 로봇 + 주방 씬을 띄워 fine-tune한 GR00T 모델이 자연어 명령("pick up the orange")을 따라 실제로 태스크를 수행하는지 측정합니다.

스크립트가 수행하는 일:

1. `~/isaaclab-pkgs/`에 `leisaac[gr00t]` + `lerobot`을 영속 설치 (한 번만)
2. SO-101 USD 씬 에셋을 `~/leisaac-assets/`로 다운로드 (한 번만)
3. leisaac 리포 clone
4. tmux 세션에서 Isaac Lab 컨테이너를 띄우고 `policy_inference.py`로 GR00T Policy Server에 ZMQ 연결

GR00T Policy Server는 별도로 띄워둬야 합니다 (보통 ECR에서 받은 컨테이너로 직접 실행).

| 환경변수 | 기본값 | 의미 |
|----------|--------|------|
| `ISAAC_LAB_IMAGE` | `nvcr.io/nvidia/isaac-lab:2.3.0` | 사용할 Isaac Lab 이미지 |
| `LEISAAC_COMMIT` | (스크립트에 명시) | leisaac 리포 고정 커밋 |

전체 closed-loop 평가 절차는 [워크숍 가이드 Module 8](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop)을 참고하세요.
