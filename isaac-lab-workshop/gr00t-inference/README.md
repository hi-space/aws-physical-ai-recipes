# GR00T N1 Inference Test Client

NVIDIA GR00T N1 추론 서버에 ZMQ를 통해 요청을 보내고 결과를 확인하는 경량 테스트 클라이언트입니다.
NVIDIA 공식 `PolicyClient` 없이 순수 ZMQ + msgpack으로 직접 통신합니다.

## 아키텍처

```mermaid
graph TB
    subgraph EC2["GPU EC2 Instance (CDK 배포)"]
        subgraph Docker["Docker: groot-n1:latest"]
            Server["gr00t/eval/run_gr00t_server.py<br/>--model_path /workspace/weights/GR00T-N1.6-3B<br/>--embodiment_tag GR1<br/>--host 0.0.0.0 --port 5555"]
        end
        EFS[("EFS<br/>GR00T-N1.6-3B<br/>모델 가중치")]
        EFS -->|volume mount| Docker
    end

    subgraph Client["Test Client (이 프로젝트)"]
        Local["test_inference.py<br/>(localhost)"]
        Remote["test_inference_remote.py<br/>(원격 IP 지정)"]
    end

    Local -->|"ZMQ REQ + msgpack<br/>tcp://localhost:5555"| Server
    Remote -->|"ZMQ REQ + msgpack<br/>tcp://&lt;IP&gt;:5555"| Server
    Server -->|"Action (16-step horizon)"| Local
    Server -->|"Action (16-step horizon)"| Remote
```

### 서버 배포 흐름 (CDK)

CDK(`infra-multiuser-groot/`)로 배포하면 `groot.sh` userdata가 자동으로:

1. HuggingFace에서 `nvidia/GR00T-N1.6-3B` 모델 가중치를 EFS에 다운로드
2. NVIDIA gr00t 리포지토리를 클론하고 Docker 이미지 빌드
3. systemd 서비스로 등록하여 부팅 시 자동 실행

| 항목 | 값 |
|------|-----|
| 모델 | GR00T-N1.6-3B (NVIDIA Foundation Model) |
| 서버 스크립트 | `gr00t/eval/run_gr00t_server.py` |
| 프로토콜 | ZMQ REQ/REP + msgpack (tcp:5555) |
| Embodiment | GR1 (NVIDIA 휴머노이드 로봇) |
| Action Horizon | 16 스텝 (한 번 추론에 16 프레임 미래 관절 명령 예측) |
| Docker Base | `nvcr.io/nvidia/pytorch:25.04-py3` |

## 구조

```
gr00t-inference/
├── pyproject.toml            # 프로젝트 의존성 (uv 기반)
├── test_inference.py         # 로컬 추론 테스트 (localhost:5555)
└── test_inference_remote.py  # 원격 추론 테스트 (IP 지정)
```

## 사전 요구사항

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) 패키지 매니저
- GR00T N1 추론 서버가 ZMQ(포트 5555)로 실행 중이어야 합니다

## 설치

```bash
uv sync
```

## 사용법

### 로컬 테스트

추론 서버가 같은 머신에서 실행 중일 때:

```bash
uv run python test_inference.py
```

### 원격 테스트

추론 서버가 원격 GPU 인스턴스에서 실행 중일 때:

```bash
uv run python test_inference_remote.py <INSTANCE_IP>
```

원격 테스트는 먼저 `ping`으로 서버 연결을 확인한 후 추론을 요청합니다. 응답 타임아웃은 10초입니다.

## 통신 프로토콜

| 항목 | 설명 |
|------|------|
| Transport | ZMQ REQ/REP (tcp://\<host\>:5555) |
| Serialization | msgpack |
| NDArray 인코딩 | numpy `.npy` 바이너리를 msgpack custom object로 래핑 |

### 요청 형식

```python
{
    "endpoint": "get_action",
    "data": {
        "observation": {
            "video": {
                "ego_view_bg_crop_pad_res256_freq20": np.ndarray  # (1, 1, 256, 256, 3) uint8
            },
            "state": {
                "left_arm":  np.ndarray,   # (1, 1, 7) float32
                "right_arm": np.ndarray,   # (1, 1, 7) float32
                "left_hand": np.ndarray,   # (1, 1, 6) float32
                "right_hand": np.ndarray,  # (1, 1, 6) float32
                "waist":     np.ndarray,   # (1, 1, 3) float32
            },
            "language": {
                "task": [["pick up the cup"]]
            }
        }
    }
}
```

### 응답 형식

성공 시 action 리스트가 반환됩니다:

```python
[
    {
        "left_arm":  np.ndarray,   # (1, 16, 7) — 16 스텝 관절 목표 위치
        "right_arm": np.ndarray,   # (1, 16, 7)
        "left_hand": np.ndarray,   # (1, 16, 6)
        "right_hand": np.ndarray,  # (1, 16, 6)
        "waist":     np.ndarray,   # (1, 16, 3)
    }
]
```

## Observation 구성 (GR1 Embodiment)

| 모달리티 | 키 | Shape | 설명 |
|----------|-----|-------|------|
| Video | `ego_view_bg_crop_pad_res256_freq20` | (B, T, 256, 256, 3) | 에고뷰 카메라 RGB 영상 |
| State | `left_arm` | (B, T, 7) | 왼팔 관절 위치 |
| State | `right_arm` | (B, T, 7) | 오른팔 관절 위치 |
| State | `left_hand` | (B, T, 6) | 왼손 관절 위치 |
| State | `right_hand` | (B, T, 6) | 오른손 관절 위치 |
| State | `waist` | (B, T, 3) | 허리 관절 위치 |
| Language | `task` | nested list | 자연어 태스크 명령 |

- `B` = batch size, `T` = temporal length (현재 테스트에서는 모두 1)

## 서버 상태 확인

CDK로 배포된 인스턴스에 SSH 접속 후:

```bash
# 서비스 상태
systemctl is-active groot-inference.service

# 포트 확인
ss -tlnp | grep 5555

# 컨테이너 확인
docker ps | grep groot

# GPU 사용량
nvidia-smi
```
