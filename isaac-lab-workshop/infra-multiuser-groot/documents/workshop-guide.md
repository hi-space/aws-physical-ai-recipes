# NVIDIA Isaac Lab on AWS — Workshop Guide

> 이 문서는 [NVIDIA Isaac Lab on AWS 워크숍](https://catalog.us-east-1.prod.workshops.aws/workshops/075ce3fe-6888-4ea9-986e-5bdd1b767ef7/en-US)의 내용과 보충 자료를 통합 정리한 것이다.

## 워크숍 개요

NVIDIA Isaac Lab과 AWS를 활용하여 휴머노이드 로봇의 강화학습 보행 정책을 학습하고, 시뮬레이션에서 결과를 확인하는 핸즈온 워크숍이다.

- 소요 시간: 약 1시간
- 난이도: Level 300 (Advanced)
- 대상: NVIDIA Omniverse Isaac Sim 경험자, AWS 기본 서비스 이해자
- 제작: Abhishek Srivastav, Shaun Kirby
- 참고 영상: [AWS re:Invent 2024 - Advancing physical AI (AIM113)](https://www.youtube.com/watch?v=LafWpmrqahY)

## 무엇을 학습하는가?

### 이 워크숍은 VLA 모델 학습이 아니다

PPO(Proximal Policy Optimization) 알고리즘으로 **Unitree H1 휴머노이드 로봇의 보행 정책(locomotion policy)** 을 학습한다. 카메라나 언어 입력 없이, 로봇 자체의 관절 센서 데이터(proprioception)만으로 울퉁불퉁한 지형 위를 걷는 방법을 배운다.

- 환경: `Isaac-Velocity-Rough-H1-v0`
- 목표: H1 휴머노이드가 거친 지형(rough terrain) 위에서 명령된 속도를 추종하며 보행
- 모델: 소규모 MLP (수 MB) — sim-to-real 전이 가능
- 알고리즘: PPO (SKRL 라이브러리)

### VLA와의 비교

| 항목 | 이 워크숍 (RL Policy) | VLA 모델 |
|------|----------------------|----------|
| 입력 | 관절 센서 데이터 (벡터) | 카메라 이미지 + 언어 명령 |
| 출력 | 관절 목표 위치 (19 DoF) | 로봇 행동 (다양한 형태) |
| 모델 크기 | 수 MB (소규모 MLP) | 수 GB (대규모 Transformer) |
| 학습 방식 | 강화학습 (PPO) | 지도학습 + 강화학습 |
| 태스크 범위 | 보행 (단일 태스크) | 범용 (멀티 태스크) |
| 대표 예시 | Isaac Lab locomotion | NVIDIA GR00T, RT-2 |

### 입력 (Observation Space)

정책 네트워크는 매 타임스텝마다 proprioceptive 관측 벡터를 입력으로 받는다:

| 관측 항목 | 차원 | 설명 |
|-----------|------|------|
| Base linear velocity | 3 | 로봇 몸통의 이동 속도 (x, y, z) |
| Base angular velocity | 3 | 로봇 몸통의 회전 속도 |
| Projected gravity | 3 | 중력 방향 대비 로봇 자세 |
| Velocity commands | 3 | 추종해야 할 목표 속도 (전진, 횡이동, 회전) |
| Joint positions | 19 | H1의 모든 관절 각도 (19 DoF) |
| Joint velocities | 19 | 모든 관절의 각속도 |
| Previous actions | 19 | 이전 타임스텝에서 출력한 명령 |

> 카메라 이미지, 언어 명령 없음 — 순수 proprioception 기반.

### 출력 (Action Space)

- Target joint positions (또는 position offsets) — 19 DoF
- 각 관절이 다음 스텝에서 도달해야 할 목표 위치
- Actuator 레벨의 PD 컨트롤러가 이를 joint torque로 변환

### 보상 설계 (Reward)

- ✅ 양의 보상: 명령 속도 추종, 안정적 자세 유지
- ❌ 음의 보상 (페널티): 넘어짐, 과도한 에너지 사용, 비정상적 관절 움직임

### 학습 파이프라인

```
┌─────────────────────────────────────────────────────────┐
│                    GPU (Isaac Sim)                       │
│                                                         │
│  수천 개의 H1 로봇이 병렬로 시뮬레이션                      │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐              │
│  │ H1  │ │ H1  │ │ H1  │ │ H1  │ │ ... │              │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘              │
│     │       │       │       │       │                   │
│     └───────┴───────┴───────┴───────┘                   │
│                     │                                    │
│              observations (벡터)                         │
│                     ▼                                    │
│           ┌─────────────────┐                           │
│           │  PPO Policy     │  ← SKRL 라이브러리가       │
│           │  (MLP 신경망)    │    PPO 알고리즘 실행       │
│           └────────┬────────┘                           │
│                    │                                     │
│              actions (관절 목표 위치)                     │
│                    ▼                                     │
│           Isaac Sim 물리 시뮬레이션                       │
└─────────────────────────────────────────────────────────┘
```

## 핵심 구성 요소

| 구성 요소 | 역할 | 비유 |
|-----------|------|------|
| **Isaac Sim** | 물리 시뮬레이션 엔진 | 훈련장 (체육관) |
| **Isaac Lab** | 로봇 학습 프레임워크 (환경, 태스크 정의) | 훈련 커리큘럼 |
| **SKRL** | RL 알고리즘 라이브러리 (PPO 등 구현) | 코치 (학습 방법론) |
| **PPO** | 사용되는 구체적 RL 알고리즘 | 코칭 전략 |
| **AWS Batch** | 멀티노드 분산 학습 인프라 | 여러 체육관에서 동시 훈련 |

### SKRL이란?

[SKRL](https://skrl.readthedocs.io/en/latest/)은 PyTorch/JAX 기반 강화학습 알고리즘 라이브러리다. PPO, SAC, TD3 등을 구현하며, Isaac Lab 환경과 네이티브 통합을 지원한다. 분산 멀티 GPU 학습을 지원하여 AWS Batch와의 조합에 적합하다.

## 사용하는 AWS 서비스

| 서비스 | 용도 |
|--------|------|
| **Amazon EC2** (GPU) | DCV 인스턴스에서 학습/시뮬레이션 실행 |
| **Amazon DCV** | GPU 원격 데스크톱 (Isaac Sim UI 접속) |
| **AWS Batch** | 멀티노드 분산 학습 (headless) |
| **Amazon EFS** | DCV ↔ Batch 간 공유 스토리지 (체크포인트, 모델) |
| **Amazon ECR** | Isaac Lab Docker 이미지 저장소 |
| **Amazon ECS** | Batch 컨테이너 오케스트레이션 |

## 워크숍 진행 흐름

### 사전 요구사항

- NVIDIA 라이선스 동의 ([NVIDIA Omniverse License Agreement](https://docs.omniverse.nvidia.com/isaacsim/latest/common/NVIDIA_Omniverse_License_Agreement.html))
- AWS 계정 (이벤트 참석 시 제공됨) — 권장 리전: `us-east-1`
- GPU 인스턴스 서비스 할당량 확인

### Module 1: Launch Isaac Lab on Amazon EC2 (~20분)

DCV 인스턴스에서 Isaac Lab RL 학습을 UI 모드로 실행한다.

1. **Review Isaac Lab Environment** — DCV로 접속하여 환경 확인
2. **Launch RL Robot Training** — Unitree H1 보행 학습 실행, Tensorboard로 메트릭 확인

EC2 구성:
- Instance Type: g6.4xlarge (1× NVIDIA L40S, 16 vCPU, 128 GiB)
- 시간당 약 $3

### Module 2: Launch Isaac Lab on AWS Batch (~20분)

AWS Batch로 headless 분산 학습을 실행한다 (2노드 × 4 GPU).

1. **Push IsaacSim Docker Image to ECR**
2. **Create Compute Environments** — Launch Template, Instance Profile 참조
3. **Create Job Definitions** — EFS 마운트 설정 포함
4. **Set Up Job Queue**
5. **Launch Robot Training Job** — CloudWatch Logs로 모니터링

Batch 구성:
- 노드당: g6.12xlarge (4× NVIDIA L40S, 48 vCPU, 384 GiB)
- 시간당 약 $10.50/노드

### Module 3: Launch Humanoid Model in IsaacSim (~15분)

학습된 모델로 시뮬레이션을 실행하고 결과를 확인한다.

1. **Mount Elastic File System** — Batch 학습 결과가 저장된 EFS 마운트
2. **Launch Trained Humanoid Model** — Interactive 모드로 H1 로봇 시뮬레이션

### Module 4: CDK and Tuning

CDK를 사용한 IaC 배포와 CloudInstanceOptimizer를 활용한 RL 튜닝을 다룬다. 학습 파라미터를 자동으로 최적화하는 black-box 옵티마이저를 AWS Batch 위에서 실행한다.

### Cleanup

워크숍 완료 후 반드시 리소스를 정리한다.

## 체크포인트 파일 가이드

워크숍에서 사용하는 두 가지 체크포인트 파일:

### agent_72000.pt (사전 제공)

- 경로: `/workspace/IsaacLab/TrainedModel/agent_72000.pt`
- 워크숍 S3 버킷에서 다운로드 → `efs-mount.sh`가 EFS에 자동 배치
- 72,000 iteration에서 저장된 ANYmal 체크포인트
- 용도: 학습 없이 바로 inference 테스트

### best_agent.pt (직접 학습)

- 경로: `/workspace/IsaacLab/TrainedModel/models/h1_rough/{timestamp}_ppo_torch/checkpoints/best_agent.pt`
- Module 2의 AWS Batch 분산 학습 실행 시 생성
- 학습 중 가장 좋은 성능을 보인 시점의 체크포인트

### 어떤 것을 사용해야 하나?

| 상황 | 사용할 체크포인트 |
|------|------------------|
| 학습 건너뛰고 inference만 테스트 | `agent_72000.pt` |
| 직접 학습 후 결과 확인 | `best_agent.pt` |

## 참고 자료

- [NVIDIA Isaac Sim](https://developer.nvidia.com/isaac-sim)
- [NVIDIA Isaac Lab](https://docs.omniverse.nvidia.com/isaacsim/latest/isaac_lab_tutorials/index.html)
- [Isaac Lab GitHub](https://github.com/isaac-sim/IsaacLab)
- [SKRL Documentation](https://skrl.readthedocs.io/en/latest/)
- [NVIDIA Isaac Sim Container Installation](https://docs.omniverse.nvidia.com/isaacsim/latest/installation/install_container.html)
- [AWS HPC Blog: Scale RL with AWS Batch](https://aws.amazon.com/blogs/hpc/scale-reinforcement-learning-with-aws-batch-multi-node-parallel-jobs/)

---

## CloudShell 기반 배포 가이드 (참가자용)

### 전체 흐름

```
1. CloudShell 환경 설정 .............. 5분
2. 할당량 사전 체크 (관리자) ......... 1분
3. 인프라 배포 (백그라운드) .......... 30~60분
4. DCV / code-server 접속
5. Isaac Lab 학습 실행
6. 리소스 정리
```

### Step 1. CloudShell 환경 설정

1. [AWS 콘솔](https://console.aws.amazon.com) 로그인
2. 우측 상단 리전을 **US East (N. Virginia) `us-east-1`** 으로 설정
3. 상단 `>_` 아이콘 클릭 → CloudShell 실행
4. 아래 명령어 실행:

```bash
git clone --depth 1 https://github.com/hi-space/aws-physical-ai-recipes.git ~/aws-physical-ai-recipes
source ~/aws-physical-ai-recipes/isaac-lab-workshop/infra-multiuser-groot/scripts/setup-cloudshell.sh
```

> 재접속 시에는 `source` 명령만 다시 실행:
> ```bash
> source ~/aws-physical-ai-recipes/isaac-lab-workshop/infra-multiuser-groot/scripts/setup-cloudshell.sh
> ```

### Step 2. 할당량 사전 체크 (관리자)

배포 전 참가자 수에 맞는 서비스 할당량이 확보되어 있는지 확인한다. 관리자가 워크숍 전에 1회 실행한다.

```bash
# 10명 배포 예정 — 체크만
./scripts/check-quotas.sh -n 10

# 부족 시 자동 증가 요청 (GPU vCPU 제외 — 별도 티켓 필요)
./scripts/check-quotas.sh -n 10 --auto-request
```

> GPU vCPU 할당량(`Running On-Demand G and VT instances`)은 자동 증가 대상이 아니므로, Service Quotas 콘솔 또는 AWS Support 티켓으로 사전 요청해야 한다. 승인에 1~3일 소요될 수 있으므로 워크숍 최소 1주 전에 요청한다.

### Step 3. 인프라 배포

관리자가 안내한 **본인 이름**과 **VPC 번호**를 사용한다.

```bash
nohup npx cdk deploy \
  -c userId=<본인이름> \
  -c vpcCidr=10.<번호>.0.0/16 \
  -c isaacSimVersion=5.1.0 \
  -c region=us-east-1 \
  --require-approval never > deploy.log 2>&1 &
```

예시 (alice, 번호 1):
```bash
nohup npx cdk deploy \
  -c userId=alice \
  -c vpcCidr=10.1.0.0/16 \
  -c isaacSimVersion=5.1.0 \
  -c region=us-east-1 \
  --require-approval never > deploy.log 2>&1 &
```

> ⚠️ CloudShell은 20분 비활성 시 세션이 종료된다. `nohup &`으로 실행하므로 세션이 끊겨도 배포는 계속 진행된다.
> **명령어 끝의 `&`를 반드시 포함해야 백그라운드로 실행된다.**

진행 확인:
```bash
tail -f deploy.log
# 또는 AWS 콘솔 → CloudFormation → 스택: IsaacLab-Stable-<본인이름>
```

### Step 4. 접속 정보 확인

배포 완료 후 (`Outputs:` 출력 시):

```bash
cat deploy.log | grep -E 'DcvUrl|CodeServerUrl|SecretArn'
```

DCV 비밀번호 확인:
```bash
aws secretsmanager get-secret-value \
  --secret-id $(cat deploy.log | grep SecretArn | awk -F= '{print $2}' | tr -d ' ') \
  --region us-east-1 \
  --query SecretString --output text | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])"
```

### Step 5. DCV 접속

1. 브라우저에서 **DcvUrl** 열기 (예: `https://1.2.3.4:8443`)
2. 인증서 경고 → "고급" → "계속 진행"
3. Username: `ubuntu` / Password: 위에서 확인한 비밀번호

접속 후 터미널을 열어 환경이 정상 설치되었는지 확인:

```bash
# GPU 드라이버 확인
nvidia-smi

# Docker 이미지 빌드 확인 (컨테이너는 직접 실행 전까지 없음)
docker images | grep isaaclab

# EFS 마운트 확인
df -h | grep efs

# code-server 상태 확인
systemctl status code-server

# GR00T 설치 확인 (활성화한 경우)
ls /home/ubuntu/environment/groot_docker
```

정상 결과:
- `nvidia-smi` → GPU 정보 출력 (L40S 또는 L4)
- `docker images | grep isaaclab` → `isaaclab-batch:latest` 이미지 존재
- `df -h | grep efs` → EFS 마운트 포인트 표시
- `code-server` → `active (running)`

문제가 있으면 UserData 로그 확인:
```bash
sudo tail -100 /var/log/cloud-init-output.log
```

### Step 6. code-server (VSCode) 접속

1. 브라우저에서 **CodeServerUrl** 열기 (예: `https://d1234.cloudfront.net`)
2. Password: DCV와 동일 (같은 Secrets Manager 시크릿 사용)

> DCV와 code-server 모두 동일한 비밀번호를 사용한다. Step 4에서 조회한 비밀번호를 그대로 입력하면 된다.

### Step 7. Isaac Lab 학습 실행

DCV 또는 code-server 터미널에서:

```bash
# Docker 컨테이너 접속
docker exec -it $(docker ps -q) bash

# 학습 실행 (headless, 빠른 학습)
cd /workspace/IsaacLab
python source/standalone/workflows/skrl/train.py \
  --task Isaac-Velocity-Rough-H1-v0 \
  --num_envs 2048 \
  --headless

# TensorBoard 모니터링 (새 터미널에서)
docker exec -it $(docker ps -q) bash
tensorboard --logdir /workspace/IsaacLab/logs --host 0.0.0.0 --port 6006
# DCV 브라우저에서 http://localhost:6006 접속
```

### Step 8. 리소스 정리

**워크숍 완료 후 반드시 실행** — GPU 인스턴스는 시간당 과금된다.

```bash
source ~/aws-physical-ai-recipes/isaac-lab-workshop/infra-multiuser-groot/scripts/setup-cloudshell.sh
npx cdk destroy -c userId=<본인이름> -c region=us-east-1
```

삭제 확인:
```bash
aws cloudformation describe-stacks \
  --stack-name IsaacLab-Stable-<본인이름> \
  --region us-east-1 2>&1 | grep -E "StackStatus|does not exist"
```

### EBS 볼륨 확장 (디스크 부족 시)

Docker 이미지 추가 빌드나 학습 데이터로 디스크가 부족할 경우, 실행 중인 인스턴스에서 바로 확장할 수 있다.

```bash
# DCV 인스턴스 내부에서 실행 (500GB로 확장)
sudo ~/aws-physical-ai-recipes/isaac-lab-workshop/infra-multiuser-groot/scripts/expand-ebs.sh 500

# 또는 CloudShell에서 인스턴스 ID 지정
./scripts/expand-ebs.sh 500 i-0abc123def456
```

스크립트가 수행하는 작업:
1. 루트 볼륨 ID 자동 조회
2. `aws ec2 modify-volume`으로 크기 변경
3. 변경 완료 대기
4. `growpart` + `resize2fs`로 파일시스템 확장

> 재부팅 없이 온라인으로 확장된다. 축소는 불가능하다.

### 트러블슈팅

| 증상 | 해결 |
|------|------|
| CloudShell 세션 끊김 | 배포는 계속 진행됨. 재접속 후 `source` 실행 → `tail -f deploy.log` 또는 CloudFormation 콘솔 확인 |
| 배포 실패 | `cat deploy.log \| grep -i "error\|fail"` 로 원인 확인 → `cdk destroy` 후 재배포 |
| DCV 접속 불가 | CloudFormation 스택 상태가 `CREATE_COMPLETE`인지 확인. 브라우저 인증서 경고 허용 필요 |
| Docker 컨테이너 없음 | UserData 실행 중일 수 있음. `sudo tail -f /var/log/cloud-init-output.log`로 진행 상황 확인 |

### 배포 파라미터 요약

| 파라미터 | 설명 | 예시 |
|----------|------|------|
| `userId` | 본인 식별자 (영문소문자, 숫자, 하이픈) | `alice`, `team-1` |
| `vpcCidr` | VPC 네트워크 대역 (참가자별 고유) | `10.1.0.0/16` |
| `isaacSimVersion` | Isaac Sim 버전 | `4.5.0`, `5.1.0` |
| `region` | AWS 리전 | `us-east-1` |
| `versionProfile` | 소프트웨어 프로필 | `stable` (기본), `latest` |
