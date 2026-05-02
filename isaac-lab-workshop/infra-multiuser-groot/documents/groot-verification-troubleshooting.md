# GR00T N1 설치 검증 및 트러블슈팅 가이드

## 설치 검증 순서

### 1. 서비스 상태 확인

```bash
# Docker 빌드 완료 확인 (active/exited = 정상)
sudo systemctl status groot-docker-build.service

# 추론 서버 실행 확인 (active/running = 정상)
sudo systemctl status groot-inference.service

# Docker 이미지 확인
docker images | grep groot

# 모델 가중치 확인 (~6GB)
du -sh /home/ubuntu/environment/efs/GR00T-N1.6-3B/
```

### 2. 포트 및 컨테이너 확인

```bash
# 5555 포트 리스닝 확인
ss -tlnp | grep 5555

# 컨테이너 실행 확인
docker ps | grep groot
```

### 3. ZMQ 추론 서버 테스트

```bash
pip3 install pyzmq

# 서버 정보 조회
python3 << 'EOF'
import zmq, json
ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.connect("tcp://localhost:5555")
sock.send_json({"action": "get_server_info"})
print(json.dumps(sock.recv_json(), indent=2))
EOF
```

### 4. 더미 추론 테스트

```bash
python3 << 'EOF'
import zmq, numpy as np

ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.connect("tcp://localhost:5555")

sock.send_json({
    "action": "infer",
    "observation": {
        "video.rgb": np.random.rand(1, 224, 224, 3).tolist(),
        "state.joint_position": np.random.rand(1, 32).tolist(),
    },
    "embodiment_tag": "GR1",
})

resp = sock.recv_json()
print("Result keys:", list(resp.keys()))
print("Action shape:", np.array(resp.get("action", [])).shape)
EOF
```

정상이면 `action` 키에 로봇 관절 명령 배열이 반환된다.

### 5. 전체 상태 한 번에 확인

```bash
echo "=== Docker Images ==="
docker images | grep -E 'groot|isaac'

echo "=== GR00T Build ==="
systemctl is-active groot-docker-build.service

echo "=== GR00T Inference ==="
systemctl is-active groot-inference.service

echo "=== Port 5555 ==="
ss -tlnp | grep 5555

echo "=== EFS Model ==="
ls /home/ubuntu/environment/efs/GR00T-N1.6-3B/ 2>/dev/null | head -5 || echo "NOT FOUND"

echo "=== GPU ==="
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv
```

---

## 트러블슈팅

### groot-docker-build.service 실패

```bash
sudo journalctl -u groot-docker-build.service --no-pager -n 100
```

| 증상 | 원인 | 해결 |
|------|------|------|
| `nvcr.io/nvidia/pytorch:25.04-py3` pull 실패 | NGC 레지스트리 접근 불가 또는 rate limit | 재시도: `sudo systemctl restart groot-docker-build.service` |
| `pip install` 실패 | 네트워크 또는 의존성 충돌 | 로그에서 실패 패키지 확인 후 수동 빌드: `cd /home/ubuntu/environment/groot_docker && docker build -t groot-n1:latest .` |
| 디스크 공간 부족 | pytorch 이미지 ~15GB + 빌드 캐시 | `docker system prune -f` 후 재시도. EBS 300GB에서 부족하면 볼륨 확장 필요 |

### groot-inference.service 실패

```bash
sudo journalctl -u groot-inference.service --no-pager -n 100
```

| 증상 | 원인 | 해결 |
|------|------|------|
| `docker: Error response from daemon: could not select device driver` | NVIDIA Container Toolkit 미설치 | `nvidia-ctk runtime configure --runtime=docker && systemctl restart docker` |
| `OOM` 또는 `CUDA out of memory` | GPU 메모리 부족 | `nvidia-smi`로 확인. 다른 프로세스가 GPU 점유 중이면 종료. g6.xlarge(24GB)에서는 모델 로드 가능 |
| `FileNotFoundError: GR00T-N1.6-3B` | EFS 마운트 안 됨 또는 모델 미다운로드 | `mount \| grep efs` 확인. 없으면 수동 마운트: `sudo mount -t nfs4 ... /home/ubuntu/environment/efs` |
| `Connection refused` on port 5555 | 빌드 미완료 | `systemctl status groot-docker-build.service` 확인. `activating` 상태면 대기 |
| `port is already allocated` | 이전 컨테이너가 남아있음 | `docker rm -f groot-inference && sudo systemctl restart groot-inference.service` |

### 모델 가중치 다운로드 실패

```bash
# 수동 다운로드
pip3 install huggingface_hub
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/GR00T-N1.6-3B', local_dir='/home/ubuntu/environment/efs/GR00T-N1.6-3B')"
```

| 증상 | 원인 | 해결 |
|------|------|------|
| `401 Unauthorized` | HuggingFace 인증 필요 | `huggingface-cli login` 후 재시도 |
| 다운로드 중단 | 네트워크 불안정 | 재실행하면 이어받기됨 |
| EFS에 쓰기 실패 | 마운트 안 됨 | `mount \| grep efs` 확인 |

### 수동으로 전체 재설치

```bash
# 1. 기존 정리
docker rm -f groot-inference 2>/dev/null
docker rmi groot-n1:latest 2>/dev/null
sudo rm -f /var/groot-done

# 2. 빌드 재시작
sudo systemctl restart groot-docker-build.service

# 3. 진행 상황 확인
sudo journalctl -u groot-docker-build.service -f
```

### 외부에서 5555 포트 접근 안 됨

| 확인 항목 | 명령어 |
|----------|--------|
| 인스턴스 내부에서 포트 열림 | `ss -tlnp \| grep 5555` |
| 보안 그룹 규칙 | AWS 콘솔 → EC2 → 인스턴스 → Security → Inbound rules에 TCP 5555 있는지 |
| GR00T 활성화 여부 | 배포 시 `grootRepoUrl`이 지정되었는지 확인. 미지정이면 SG에 5555 포트 미추가 |

> 참고: 5555 포트는 ZMQ 프로토콜이므로 브라우저로 접속하면 아무것도 보이지 않는다. Python ZMQ 클라이언트로만 접근 가능.

---

## 공식 GR00T 검증 방법 (NVIDIA Isaac-GR00T 리포지토리)

> 출처: [github.com/NVIDIA/Isaac-GR00T](https://github.com/NVIDIA/Isaac-GR00T)

### Quick Start: 추론 서버 + 클라이언트

```bash
# 서버 시작 (이미 systemd로 실행 중이면 생략)
uv run python gr00t/eval/run_gr00t_server.py \
  --embodiment-tag GR1 \
  --model-path nvidia/GR00T-N1.6-3B \
  --device cuda:0 \
  --host 0.0.0.0 \
  --port 5555
```

```python
# 클라이언트에서 연결 테스트
from gr00t.policy.server_client import PolicyClient

policy = PolicyClient(host="localhost", port=5555)
if policy.ping():
    print("GR00T 서버 연결 성공")
```

### Standalone 추론 (서버 없이 직접 실행)

```bash
uv run python scripts/deployment/standalone_inference_script.py \
  --model-path nvidia/GR00T-N1.6-3B \
  --dataset-path demo_data/gr1.PickNPlace \
  --embodiment-tag GR1 \
  --traj-ids 0 1 2 \
  --inference-mode pytorch \
  --action-horizon 8
```

### Open-Loop 평가 (오프라인, 데이터셋 기반)

모델의 예측 액션과 ground truth를 비교하여 정확도를 평가한다.

```bash
uv run python gr00t/eval/open_loop_eval.py \
  --dataset-path <DATASET_PATH> \
  --embodiment-tag GR1 \
  --model-path nvidia/GR00T-N1.6-3B \
  --traj-ids 0 \
  --action-horizon 16
```

결과: `/tmp/open_loop_eval/traj_0.jpeg`에 ground truth vs predicted 시각화 생성.

### ReplayPolicy로 디버깅

학습된 모델 없이 기존 데이터셋의 액션을 재생하여 환경 설정이 올바른지 검증한다.

```bash
uv run python gr00t/eval/run_gr00t_server.py \
  --dataset-path <DATASET_PATH> \
  --embodiment-tag GR1 \
  --execution-horizon 8
```

### 시뮬레이션 벤치마크 (Closed-Loop)

| 벤치마크 | 설명 | 가이드 |
|----------|------|--------|
| RoboCasa | Zero-shot 평가 (파인튜닝 없이) | [examples/robocasa](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/robocasa/README.md) |
| RoboCasa GR1 Tabletop | GR1 로봇 테이블탑 태스크 | [examples/robocasa-gr1-tabletop-tasks](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/robocasa-gr1-tabletop-tasks/README.md) |
| LIBERO | 파인튜닝 후 평가 | [examples/LIBERO](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/LIBERO/README.md) |
| SimplerEnv | WidowX/Google 로봇 | [examples/SimplerEnv](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/SimplerEnv/README.md) |
| BEHAVIOR | Galaxea R1 Pro 로코매니퓰레이션 | [examples/BEHAVIOR](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/BEHAVIOR/README.md) |
| G1 WholeBodyControl | Unitree G1 전신 제어 | [examples/GR00T-WholeBodyControl](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/GR00T-WholeBodyControl/README.md) |
| PointNav | 내비게이션 | [examples/PointNav](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/PointNav/README.md) |
| SO-100 | SO-100 로봇 | [examples/SO100](https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/SO100/README.md) |

### 추론 성능 참고 (GR00T N1.6-3B)

| GPU | 모드 | E2E 지연 | 주파수 |
|-----|------|---------|--------|
| RTX 5090 | torch.compile | 37ms | 27.3 Hz |
| H100 | torch.compile | 38ms | 26.3 Hz |
| RTX 4090 | torch.compile | 44ms | 22.8 Hz |

> L4(g6 인스턴스)와 L40S(g6e 인스턴스)의 공식 벤치마크는 아직 제공되지 않음. RTX 4090 수준 또는 그 이하로 예상.

### 환경 검증 스크립트

공식 리포지토리에서 시뮬레이션 평가 환경이 올바르게 설정되었는지 확인하는 스크립트를 제공한다.

```bash
uv run python scripts/eval/check_sim_eval_ready.py
```
