# GR00T Inference

Fine-tune한 GR00T 모델을 시뮬레이션 안에서 검증하는 경로를 제공합니다.

## Overview

```
inference/
├── batch-zmq/         GR00T ZMQ 추론 서버 ping 클라이언트 (디버깅·검증용)
└── run-isaaclab.sh    Isaac Lab + LeIsaac으로 closed-loop 시뮬레이션 평가
```

상황별 선택:

| 상황 | 사용할 경로 |
|------|-------------|
| DCV 인스턴스에서 GR00T Policy Server가 살아있는지 빠르게 확인하고 싶다 | [`batch-zmq/`](./batch-zmq/) |
| Fine-tune한 모델로 시뮬레이터 안에서 로봇이 실제 태스크를 수행하는지 평가하고 싶다 | `run-isaaclab.sh` |

> 학습된 모델 아티팩트는 SageMaker Pipeline의 학습 잡이 끝에 source에서 압축 해제된 채로 직접 `s3://<bucket>/<model.s3_prefix>/<execution-id>/`에 업로드합니다(단일 스텝 파이프라인). DCV 인스턴스에서 이 prefix를 `aws s3 sync`로 받아 IsaacSim에서 로드합니다. 자세한 내용은 [`../pipeline/README.md`](../pipeline/README.md).

## Batch ZMQ Client

GR00T 공식 추론 서버(`run_gr00t_server.py`)는 ZMQ REQ/REP 소켓으로 동작합니다. 이 디렉토리의 작은 클라이언트는 그 서버에 ping을 보내고 더미 observation 한 번을 inference 해서 서버가 정상인지 빠르게 검증합니다.

```bash
cd batch-zmq
uv run python test_inference.py                       # 같은 머신
uv run python test_inference_remote.py <INSTANCE_IP>  # 원격
```

GR00T base 모델(GR1 임베디먼트) 검증용 더미 데이터를 사용하므로 fine-tune 결과 검증은 아래 시뮬레이션 평가(`run-isaaclab.sh`)를 쓰세요. 자세한 프로토콜은 [`batch-zmq/README.md`](./batch-zmq/README.md).

> 워크숍 모듈 3(VLA 인프라 + base 모델 추론 검증)은 이 클라이언트를 그대로 노트북으로 감싼 [`../notebooks/01_infra_and_base_check.ipynb`](../notebooks/01_infra_and_base_check.ipynb)로 실행할 수 있습니다.

## Closed-loop Evaluation (`run-isaaclab.sh`)

DCV 인스턴스에서 호출하는 bash 스크립트. Isaac Lab 컨테이너 안에서 [LeIsaac](https://github.com/LightwheelAI/leisaac) 패키지를 설치하고, SO-101 로봇 + 주방 씬을 띄워 fine-tune한 GR00T 모델이 자연어 명령("pick up the orange")을 따라 실제로 태스크를 수행하는지 측정합니다.

스크립트가 수행하는 일:

1. `~/isaaclab-pkgs/`에 `leisaac[gr00t]` + `lerobot`을 영속 설치 (한 번만)
2. SO-101 USD 씬 에셋을 `~/leisaac-assets/`로 다운로드 (한 번만)
3. leisaac 리포 clone
4. `docker run -it`로 Isaac Lab 컨테이너를 대화형으로 띄우고, 컨테이너 안에서 `policy_inference.py`로 GR00T Policy Server에 ZMQ 연결

GR00T Policy Server는 별도로 띄워둬야 합니다 (보통 ECR에서 받은 컨테이너로 직접 실행).

| 환경변수 | 기본값 | 의미 |
|----------|--------|------|
| `ISAAC_LAB_IMAGE` | `nvcr.io/nvidia/isaac-lab:2.3.0` | 사용할 Isaac Lab 이미지 |
| `LEISAAC_COMMIT` | (스크립트에 명시) | leisaac 리포 고정 커밋 |

워크숍 모듈 5(Closed-loop 평가)는 이 스크립트를 감싼 [`../notebooks/03_closed_loop_eval.ipynb`](../notebooks/03_closed_loop_eval.ipynb)로 실행할 수 있습니다. 전체 절차는 [워크숍 가이드 모듈 5](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop)를 참고하세요.
