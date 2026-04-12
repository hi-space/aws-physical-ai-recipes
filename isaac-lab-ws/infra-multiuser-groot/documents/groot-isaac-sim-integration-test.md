# GR00T + Isaac Sim 통합 시뮬레이션 테스트 가이드

CDK 배포 환경에서 GR00T 추론 서버와 Isaac Sim 기반 시뮬레이션을 연동하여 테스트하는 방법.

## 아키텍처

```
DCV 인스턴스 (GPU)
├── GR00T 추론 서버 (Docker, 포트 5555)
│   └── 모델: EFS/GR00T-N1.6-3B
│
├── 시뮬레이션 환경 (Isaac Sim / OmniGibson)
│   └── 관측값 → ZMQ(localhost:5555) → GR00T 서버
│   └── 액션   ← ZMQ(localhost:5555) ← 로봇 실행
│
└── DCV 브라우저로 시각화 확인
```

모든 통신이 같은 인스턴스 내 localhost:5555로 이루어지므로 네트워크 설정 불필요.

## 사전 조건

- CDK 배포 완료 (GR00T 활성화)
- `groot-inference.service` 실행 중 확인:
  ```bash
  systemctl is-active groot-inference.service
  ss -tlnp | grep 5555
  ```

## 테스트 가능한 벤치마크

| 벤치마크 | 시뮬레이터 | 로봇 | 파인튜닝 필요 | 난이도 | GPU 요구 |
|----------|-----------|------|:------------:|:------:|---------|
| RoboCasa GR1 Tabletop | robosuite (Isaac Sim) | GR1 | ❌ Zero-shot | 쉬움 | L4/L40S |
| RoboCasa | robosuite (Isaac Sim) | Franka Panda | ❌ Zero-shot | 쉬움 | L4/L40S |
| BEHAVIOR | OmniGibson (Isaac Sim) | Galaxea R1 Pro | ❌ 체크포인트 제공 | 중간 | L4/L40S (RT Core) |
| G1 WholeBodyControl | Isaac Sim | Unitree G1 | ✅ 체크포인트 제공 | 중간 | L4/L40S |

---

## 1. RoboCasa GR1 Tabletop (추천 — Zero-shot, 가장 간단)

파인튜닝 없이 GR1 휴머노이드가 테이블 위 물체를 조작하는 것을 시연할 수 있다.

### 환경 설치

```bash
cd /home/ubuntu/environment
git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git gr00t_eval
cd gr00t_eval

# 의존성 설치
bash scripts/deployment/dgpu/install_deps.sh
source .venv/bin/activate

# RoboCasa GR1 환경 설정
bash examples/robocasa-gr1-tabletop-tasks/setup_env.sh
```

### 실행

GR00T 추론 서버는 이미 systemd로 실행 중이므로 시뮬레이션 클라이언트만 실행:

```bash
source .venv/bin/activate

uv run python gr00t/eval/rollout_policy.py \
  --policy_client_host 127.0.0.1 \
  --policy_client_port 5555 \
  --env_name robocasa_gr1/PnPCounterToCab \
  --n_episodes 5 \
  --n_action_steps 8
```

### 사용 가능한 태스크

```
robocasa_gr1/PnPCounterToCab      # 카운터 → 캐비닛 물체 이동
robocasa_gr1/PnPCabToCounter      # 캐비닛 → 카운터 물체 이동
robocasa_gr1/PnPCounterToSink     # 카운터 → 싱크대 물체 이동
```

> 상세: https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/robocasa-gr1-tabletop-tasks/README.md

---

## 2. RoboCasa (Franka Panda, Zero-shot)

### 환경 설치

```bash
cd /home/ubuntu/environment/gr00t_eval
bash examples/robocasa/setup_env.sh
```

### 실행

```bash
# 터미널 1: GR00T 서버 (기본 모델로 실행 — systemd 서비스 중지 후 수동 실행)
sudo systemctl stop groot-inference.service

source .venv/bin/activate
uv run python gr00t/eval/run_gr00t_server.py \
  --model-path nvidia/GR00T-N1.6-3B \
  --embodiment-tag new_embodiment \
  --use-sim-policy-wrapper

# 터미널 2: 시뮬레이션 클라이언트
source .venv/bin/activate
uv run python gr00t/eval/rollout_policy.py \
  --policy_client_host 127.0.0.1 \
  --policy_client_port 5555 \
  --env_name robocasa/PnPCounterToCab \
  --n_episodes 5 \
  --n_action_steps 8
```

> 상세: https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/robocasa/README.md

---

## 3. BEHAVIOR (50개 가정 태스크, Isaac Sim 기반)

OmniGibson(Isaac Sim 기반)에서 Galaxea R1 Pro 로봇이 가정 환경 태스크를 수행한다.
사전 학습된 50태스크 체크포인트(`nvidia/GR00T-N1.6-BEHAVIOR1k`)가 제공된다.

### 환경 설치

```bash
cd /home/ubuntu/environment
git clone https://github.com/StanfordVL/BEHAVIOR-1K.git
cd BEHAVIOR-1K
git checkout feat/task-progress

# GR00T venv 활성화 후 설치
source /home/ubuntu/environment/gr00t_eval/.venv/bin/activate
bash ./setup_uv.sh

# 테스트 케이스 다운로드
cd /home/ubuntu/environment/gr00t_eval
python gr00t/eval/sim/BEHAVIOR/prepare_test_instances.py
```

### 실행

```bash
# 터미널 1: GR00T 서버 (BEHAVIOR 체크포인트)
sudo systemctl stop groot-inference.service

source .venv/bin/activate
uv run python gr00t/eval/run_gr00t_server.py \
  --model-path nvidia/GR00T-N1.6-BEHAVIOR1k \
  --embodiment-tag BEHAVIOR_R1_PRO \
  --use-sim-policy-wrapper

# 터미널 2: BEHAVIOR 시뮬레이션 클라이언트
source .venv/bin/activate
uv run python gr00t/eval/rollout_policy.py \
  --n_episodes 10 \
  --policy_client_host 127.0.0.1 \
  --policy_client_port 5555 \
  --env_name sim_behavior_r1_pro/turning_on_radio \
  --n_action_steps 8 \
  --n_envs 1 \
  --max_episode_steps 999999999
```

### 주요 태스크 예시

```
sim_behavior_r1_pro/turning_on_radio           # 라디오 켜기 (60% 성공률)
sim_behavior_r1_pro/clean_a_trumpet            # 트럼펫 청소
sim_behavior_r1_pro/boxing_books_up_for_storage # 책 상자 정리
sim_behavior_r1_pro/picking_up_trash           # 쓰레기 줍기
sim_behavior_r1_pro/cook_bacon                 # 베이컨 요리
```

> 전체 50개 태스크 목록: https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/BEHAVIOR/README.md

### 주의사항

- BEHAVIOR는 **RT Core GPU 필요** (g6의 L4, g6e의 L40S 모두 지원)
- A100/H100은 RT Core가 없어 미지원
- `max_episode_steps`를 큰 값으로 설정하는 이유: BEHAVIOR가 기본적으로 2x human steps를 horizon으로 사용

---

## 4. G1 WholeBodyControl (Unitree G1 전신 제어)

### 데이터셋 다운로드

```bash
huggingface-cli download nvidia/GR00T-N1.6-G1-PnPAppleToPlate \
  --local-dir /home/ubuntu/environment/efs/GR00T-N1.6-G1-PnPAppleToPlate
```

### 실행

```bash
# 터미널 1: GR00T 서버
sudo systemctl stop groot-inference.service

source /home/ubuntu/environment/gr00t_eval/.venv/bin/activate
uv run python gr00t/eval/run_gr00t_server.py \
  --model-path nvidia/GR00T-N1.6-G1-PnPAppleToPlate \
  --embodiment-tag UNITREE_G1 \
  --use-sim-policy-wrapper

# 터미널 2: 시뮬레이션
source .venv/bin/activate
uv run python gr00t/eval/rollout_policy.py \
  --policy_client_host 127.0.0.1 \
  --policy_client_port 5555 \
  --env_name g1_loco_manipulation/PnPAppleToPlate \
  --n_episodes 5 \
  --n_action_steps 8
```

> 상세: https://github.com/NVIDIA/Isaac-GR00T/blob/main/examples/GR00T-WholeBodyControl/README.md

---

## 트러블슈팅

### 시뮬레이션이 시작되지 않음

```bash
# GPU 상태 확인 (메모리 부족 여부)
nvidia-smi

# GR00T 서버가 GPU 메모리를 점유 중이면 서버 중지 후 재시작
sudo systemctl stop groot-inference.service
# 수동으로 필요한 체크포인트로 서버 재시작
```

### BEHAVIOR에서 "RT Core not found" 에러

- g6(L4) 또는 g6e(L40S) 인스턴스인지 확인
- A100/H100 기반 인스턴스에서는 BEHAVIOR 실행 불가

### systemd 서비스와 수동 실행 충돌

벤치마크별로 다른 체크포인트/embodiment를 사용하므로, 수동 실행 전에 systemd 서비스를 중지해야 한다:

```bash
# systemd 서비스 중지
sudo systemctl stop groot-inference.service

# 수동 실행 (원하는 체크포인트로)
uv run python gr00t/eval/run_gr00t_server.py --model-path <체크포인트> ...

# 테스트 완료 후 기본 서비스 재시작
sudo systemctl start groot-inference.service
```

### 환경 설치 검증

```bash
cd /home/ubuntu/environment/gr00t_eval
uv run python scripts/eval/check_sim_eval_ready.py
```

이 스크립트가 각 시뮬레이션 환경의 의존성이 올바르게 설치되었는지 확인해준다.
