# GR00T VLA Fine-tuning Workshop on AWS HyperPod

AWS SageMaker HyperPod + NVIDIA Isaac GR00T N1.7을 활용한 Vision-Language-Action 모델 파인튜닝 실습 가이드

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  AWS SageMaker HyperPod (SLURM Managed)                     │
│                                                             │
│  ┌──────────────┐     ┌──────────────────────────────────┐  │
│  │  Head Node   │     │  Compute Node (GPU)              │  │
│  │  ml.m5.xlarge│────▶│  ml.g5.4xlarge (1x A10G 24GB)   │  │
│  │  SLURM ctrl  │     │  or ml.g5.12xlarge (4x A10G)    │  │
│  └──────┬───────┘     └──────────────┬───────────────────┘  │
│         │                            │                      │
│  ┌──────┴────────────────────────────┴───────────────────┐  │
│  │  FSx for Lustre (/fsx) - 1.2TB Shared Storage         │  │
│  │  /datasets  ← S3 auto-import                          │  │
│  │  /checkpoints → S3 auto-export                        │  │
│  │  /envs/gr00t  - Python virtual environment            │  │
│  │  /scratch     - Repo, logs, temp                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Item | Description |
|------|-------------|
| AWS Account | HyperPod 클러스터 배포 완료 |
| HuggingFace Account | nvidia/GR00T-N1.7-3B 모델 access 승인 필요 |
| SSH Key | Jump host + cluster access key |

### HuggingFace Model Access (필수)

GR00T N1.7은 gated model입니다. 아래 두 모델에 대한 access를 요청하세요:

1. https://huggingface.co/nvidia/GR00T-N1.7-3B → "Request access"
2. https://huggingface.co/nvidia/Cosmos-Reason2-2B → "Request access"
3. https://huggingface.co/settings/tokens 에서 token 생성 (Read 권한)

---

## Step 1: HyperPod 클러스터 접속

### 1.1 Jump Host를 통한 SSH 접속

```bash
# Jump host 접속
ssh -i <jump-key.pem> ec2-user@<JUMP_HOST_IP>

# Head node 접속
ssh -i ~/.ssh/cluster_access_key ubuntu@<HEAD_NODE_IP>
```

또는 SSM을 통한 직접 접속:
```bash
aws ssm start-session \
  --target sagemaker-cluster:<CLUSTER_ID>_head-<INSTANCE_ID> \
  --region <REGION>
```

### 1.2 클러스터 상태 확인

```bash
# SLURM 파티션 및 노드 확인
sinfo
squeue

# FSx 마운트 확인
df -h /fsx
ls /fsx/
```

**예상 출력:**
```
PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST
dev*         up   infinite      1  idle  ip-10-0-1-xxx
```

> `dev` 파티션에 compute node 1대가 idle 상태로 표시됩니다.

---

## Step 2: GR00T 학습 환경 설정

### 2.1 HuggingFace 토큰 설정

학습 시 gated model 다운로드를 위해 먼저 토큰을 저장합니다:

```bash
mkdir -p /fsx/scratch
echo "hf_xxxxxxxxxxxx" > /fsx/scratch/.hf_token
```

> 이 파일은 학습 스크립트에서 자동으로 읽어 사용합니다.

### 2.2 레시피 저장소 클론

학습 스크립트와 설정 파일을 FSx에 가져옵니다:

```bash
sudo apt-get install -y git git-lfs 2>/dev/null || true
cd /fsx/scratch
git clone https://github.com/hi-space/aws-physical-ai-recipes.git
```

### 2.3 환경 설치 스크립트 실행

```bash
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh
```

이 스크립트는 다음을 수행합니다:
- 시스템 패키지 설치 (`ffmpeg`, `git-lfs`)
- `uv` 패키지 매니저 설치
- Isaac-GR00T 저장소 클론 (`/fsx/scratch/Isaac-GR00T`)
- Python 3.10 가상환경 생성 (`/fsx/envs/gr00t`)
- GR00T 패키지 + 의존성 설치 (`bitsandbytes`, `flash-attn` 등, 약 5-10분)

### 2.4 설치 확인

```bash
source /fsx/envs/gr00t/bin/activate
python -c "import gr00t; print('GR00T OK')"
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA: {torch.cuda.is_available()}')"
```

> Note: GPU가 있는 compute node에서는 `CUDA: True`가 출력됩니다.

---

## Step 3: 데이터셋 준비

### 3.1 데모 데이터 사용 (빠른 테스트)

Isaac-GR00T에 포함된 DROID 샘플 데이터를 사용합니다. sbatch 기본 경로(`/fsx/datasets/groot/demo_data`)에 복사합니다:

```bash
mkdir -p /fsx/datasets/groot
cp -r /fsx/scratch/Isaac-GR00T/demo_data/droid_sample /fsx/datasets/groot/demo_data
ls /fsx/datasets/groot/demo_data/
```

**출력:**
```
data/  meta/  videos/
```

> 복사 없이 직접 사용하려면 학습 시 `DATASET_PATH=/fsx/scratch/Isaac-GR00T/demo_data/droid_sample`를 지정하세요.

### 3.2 커스텀 데이터셋 업로드 (선택)

S3에 업로드하면 FSx DRA를 통해 자동으로 `/fsx/datasets/`에 동기화됩니다:

```bash
aws s3 cp --recursive ./my_dataset s3://<YOUR-DATA-BUCKET>/datasets/groot/my_dataset/
```

### 3.3 지원되는 Embodiment Tags

| Tag | Robot/Dataset | 비고 |
|-----|---------------|------|
| `OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT` | DROID dataset | Zero-shot + Fine-tune |
| `LIBERO_PANDA` | LIBERO simulation | Fine-tune only |
| `SIMPLER_ENV_GOOGLE` | SimplerEnv Google Robot | Fine-tune only |
| `SIMPLER_ENV_WIDOWX` | SimplerEnv WidowX | Fine-tune only |
| `XDOF` | Generic X-DOF | Zero-shot |
| `REAL_G1` | Unitree G1 | Zero-shot |
| `NEW_EMBODIMENT` | Custom robot | `--modality-config-path` 필요 |

---

## Step 4: 학습 실행

### 4.1 테스트 학습 (10 steps)

```bash
export HF_TOKEN="hf_xxxxxxxxxxxx"
# 또는: echo "hf_xxxxxxxxxxxx" > /fsx/scratch/.hf_token

sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch
```

기본 설정으로 실행됩니다:
- Dataset: `/fsx/datasets/groot/demo_data` (Step 3.1에서 복사한 경로)
- GPU: 1개 A10G
- Batch size: 2, Max steps: 2000

### 4.2 커스텀 설정으로 학습

```bash
export HF_TOKEN="hf_xxxxxxxxxxxx"
export MAX_STEPS=10            # 테스트용 짧은 학습
export DATASET_PATH=/fsx/datasets/groot/demo_data  # 커스텀 데이터셋 경로
export EMBODIMENT_TAG=OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT

sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch
```

### 4.3 학습 모니터링

```bash
# Job 상태 확인
squeue

# 실시간 로그 확인
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out

# 에러 로그
cat /fsx/scratch/logs/groot-<JOB_ID>.err
```

**정상 학습 진행 시 로그 예시** (`MAX_STEPS=10`으로 테스트 시):
```
🚀 Starting training...
  0%|          | 0/10 [00:00<?, ?it/s]
 10%|█         | 1/10 [00:58<08:47, 58.65s/it]
 ...
100%|██████████| 10/10 [01:11<00:00,  2.07s/it]
Model saved to /fsx/checkpoints/vla/groot-demo_data
Training completed!
```

### 4.4 학습 파라미터

| Parameter | Default | Description |
|-----------|---------|-------------|
| `NUM_GPUS` | 1 | 사용할 GPU 수 |
| `MAX_STEPS` | 2000 | 총 학습 스텝 |
| `GLOBAL_BATCH_SIZE` | 2 | 글로벌 배치 사이즈 |
| `GRAD_ACCUM` | GLOBAL_BATCH_SIZE | Gradient accumulation steps |
| `SAVE_STEPS` | 2000 | 체크포인트 저장 주기 |
| `BASE_MODEL` | nvidia/GR00T-N1.7-3B | 베이스 모델 |
| `DATASET` | demo_data | 데이터셋 이름 |
| `DATASET_PATH` | /fsx/datasets/groot/{DATASET} | 데이터셋 전체 경로 (DATASET보다 우선) |
| `OUTPUT_DIR` | /fsx/checkpoints/vla/groot-{DATASET} | 체크포인트 저장 경로 |

### 4.5 메모리 최적화 (자동 적용)

학습 스크립트는 A10G (24GB)에서 동작하도록 다음 최적화를 자동 적용합니다:

| 최적화 | 효과 |
|--------|------|
| BF16 model loading | 모델 가중치 메모리 절반 감소 (~12GB → ~6GB) |
| Gradient checkpointing | 활성화 메모리 절약 (속도↓ 메모리↑) |
| 8-bit PagedAdam optimizer | 옵티마이저 상태 메모리 75% 감소 |

---

## Step 5: 결과 확인

### 5.1 체크포인트 확인

```bash
ls /fsx/checkpoints/vla/groot-demo_data/checkpoint-*/
```

**예상 출력:**
```
config.json  embodiment_id.json  model-00001-of-00002.safetensors
model-00002-of-00002.safetensors  model.safetensors.index.json
optimizer.pt  processor_config.json  rng_state.pth  scheduler.pt
statistics.json  trainer_state.json  training_args.bin  wandb_config.json
```

### 5.2 Open-loop 추론 테스트

학습된 모델로 데이터셋 대비 추론 정확도를 확인합니다:

```bash
export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
source /fsx/envs/gr00t/bin/activate
cd /fsx/scratch/Isaac-GR00T

python /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/examples/vla/verify_in_sim.py \
  --model-path /fsx/checkpoints/vla/groot-demo_data/checkpoint-2000 \
  --dataset-path /fsx/datasets/groot/demo_data \
  --embodiment-tag OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT \
  --traj-ids 0 1 2
```

> `MAX_STEPS=10`으로 테스트한 경우 `checkpoint-10`을 사용하세요.

**예상 출력:**
```
  Trajectory 0:
    Steps evaluated: 7, MSE: 0.016083
  Trajectory 1:
    Steps evaluated: 7, MSE: 0.001609
  Trajectory 2:
    Steps evaluated: 7, MSE: 0.034067

Overall MSE: 0.017253 (+/- 0.013277)
```

**결과:** 각 trajectory별 MSE (Mean Squared Error)가 출력됩니다. 값이 작을수록 예측 정확도가 높습니다.

### 5.3 간단한 추론 확인

```bash
export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
source /fsx/envs/gr00t/bin/activate
cd /fsx/scratch/Isaac-GR00T

python -c "
from gr00t.policy.gr00t_policy import Gr00tPolicy
from gr00t.data.embodiment_tags import EmbodimentTag

policy = Gr00tPolicy(
    embodiment_tag=EmbodimentTag.OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT,
    model_path='/fsx/checkpoints/vla/groot-demo_data/checkpoint-2000',
    device='cuda:0'
)
print('Model loaded successfully!')
print('Modality config:', list(policy.get_modality_config().keys()))
"
```

> `MAX_STEPS=10`으로 테스트한 경우 `checkpoint-10` 경로를 사용하세요.

**예상 출력:**
```
Model loaded successfully!
Modality config: ['video', 'state', 'action', 'language']
```

### 5.4 Closed-loop 시뮬레이션 평가 (Isaac Sim)

학습된 GR00T 모델을 Isaac Sim 환경에서 실시간으로 평가합니다. Policy Server가 모델 추론을 수행하고, Isaac Sim 클라이언트가 카메라 이미지와 로봇 상태를 전송하여 액션을 받아 적용합니다.

#### Isaac Sim 환경 설정

Isaac Sim 컨테이너와 워크샵 태스크 패키지가 필요합니다:

```bash
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_isaaclab_env.sh
```

> 이 스크립트는 NGC에서 Isaac Sim 컨테이너를 가져오고, SO-101 로봇 태스크 패키지를 설치합니다. 약 15-20분 소요됩니다.

#### Closed-loop 평가 실행

```bash
export HF_TOKEN=$(cat /fsx/scratch/.hf_token)

sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/eval_closed_loop.sbatch
```

기본 설정으로 실행됩니다:
- Model: `/fsx/checkpoints/vla/groot-demo_data/checkpoint-2000`
- Embodiment: `OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT`
- Instruction: "pick up the cube"
- Simulation steps: 3000

#### 커스텀 설정으로 실행

```bash
export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
MODEL_PATH=/fsx/checkpoints/vla/groot-demo_data/checkpoint-10 \
NUM_STEPS=1000 \
INSTRUCTION="pick up the cube" \
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/eval_closed_loop.sbatch
```

> `MAX_STEPS=10`으로 학습한 경우 `MODEL_PATH`에 `checkpoint-10`을 지정하세요.

#### 모니터링

```bash
# 실시간 로그
tail -f /fsx/scratch/logs/closed-loop-<JOB_ID>.out
```

#### 예상 출력

```
[1/3] Starting GR00T Policy Server (port 5556)...
  Policy server ready! (took 66s)

[2/3] Running Isaac Sim closed-loop evaluation...
Connected to GR00T Policy Server at localhost:5556
  Video keys: ['exterior_image_1_left', 'wrist_image_left']
  State keys: ['eef_9d', 'gripper_position', 'joint_position']
  Action keys: ['eef_9d', 'gripper_position', 'joint_position']
Step 0/1000 — policy calls: 1, queued: 39
Step 500/1000 — policy calls: 13, queued: 19
Closed-loop simulation complete.

[3/3] Stopping policy server...
Closed-loop evaluation completed successfully!
```

**결과:** 모델이 16-step action horizon을 생성하여 Isaac Sim 내 SO-101 로봇을 제어합니다. `policy calls` 수와 `queued` 액션 수로 추론 빈도를 확인할 수 있습니다.

#### 동작 원리

```
┌─────────────────────────────────────────────────────────┐
│  Compute Node (GPU)                                     │
│                                                         │
│  ┌─────────────────┐     ZMQ (tcp:5556)    ┌─────────┐ │
│  │  Isaac Sim       │ ──────────────────── │  GR00T  │ │
│  │  (SO-101 robot)  │  obs: camera + state │  Policy │ │
│  │  + cameras       │ ◀─────────────────── │  Server │ │
│  │                  │  action: 16-step     │         │ │
│  └─────────────────┘                       └─────────┘ │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Step 6: 컴퓨트 노드 스케일링

### 6.1 현재 클러스터 구성 확인

```bash
aws sagemaker describe-cluster --cluster-name <CLUSTER_NAME> --region <REGION> \
  --query 'InstanceGroups[].{Name:InstanceGroupName,Type:InstanceType,Count:CurrentCount}' \
  --output table
```

### 6.2 노드 스케일 업/다운

```bash
# 모든 instance group을 포함하여 업데이트 (생략하면 기존 그룹이 삭제됩니다!)
aws sagemaker update-cluster --cluster-name <CLUSTER_NAME> --region <REGION> \
  --instance-groups '[
    {"InstanceGroupName":"head","InstanceType":"ml.m5.xlarge","InstanceCount":1,...},
    {"InstanceGroupName":"train","InstanceType":"ml.g5.12xlarge","InstanceCount":1,...}
  ]'
```

> **중요:** `update-cluster`는 ALL instance groups를 명시해야 합니다. 누락된 그룹은 삭제됩니다.

---

## Troubleshooting

### OOM (Out of Memory) 에러

```
torch.OutOfMemoryError: CUDA out of memory.
```

원인: 메모리 최적화가 적용되지 않았거나 batch size가 큼

해결:
```bash
# batch size 줄이기
export GLOBAL_BATCH_SIZE=1
# 또는 학습 스크립트에 메모리 최적화가 적용되어 있는지 확인
grep "load_bf16 = True" /fsx/scratch/Isaac-GR00T/gr00t/experiment/launch_finetune.py
```

### FSx가 마운트되지 않은 경우

```bash
sudo mount /fsx
df -h /fsx
```

### Compute node에서 slurmd가 시작되지 않은 경우

```bash
# Head node에서 compute node에 SSH 접속
ssh ubuntu@<compute-node-ip>

# slurmd 시작
sudo systemctl enable slurmd
sudo systemctl start slurmd
systemctl status slurmd
```

### HuggingFace 모델 다운로드 실패

```
OSError: You are trying to access a gated repo.
```

해결:
1. HuggingFace에서 `nvidia/GR00T-N1.7-3B`와 `nvidia/Cosmos-Reason2-2B` 모두 access 승인
2. 토큰 설정 확인:
```bash
echo "hf_xxxxxxxxxxxx" > /fsx/scratch/.hf_token
# 또는
export HF_TOKEN="hf_xxxxxxxxxxxx"
```

### FFmpeg / torchcodec 오류

```
RuntimeError: No FFmpeg installation found
```

해결:
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

### GPU 용량 부족 (InsufficientCapacityException)

```
FailureMessage: We currently do not have sufficient capacity
```

해결: `ml.g5.4xlarge` (1x A10G)로 충분합니다. 다른 인스턴스 타입 시도 또는 시간을 두고 재시도.

### SLURM 노드가 NOT_RESPONDING 또는 CF 상태

```bash
# Head node에서 확인
sinfo
# idle* (asterisk = not responding)
# alloc~ (tilde = cloud/power-save mode)

# Compute node에서 slurmd 재시작
ssh ubuntu@<node-ip> 'sudo systemctl restart slurmd'
```

노드 스케일업 후 Job이 `CF` (configuring) 상태에 머무르는 경우:
```bash
# Compute node에서 conf-server IP 확인
ssh ubuntu@<node-ip> 'cat /opt/slurm/etc/default/slurmd'

# Head node IP와 다르면 수정
ssh ubuntu@<node-ip> 'echo "SLURMD_OPTIONS=--conf-server <HEAD_NODE_IP>" | sudo tee /opt/slurm/etc/default/slurmd && sudo systemctl restart slurmd'
```

---

## Workshop Flow Summary

```
Step 1: 클러스터 접속 및 상태 확인        (2분)
Step 2: 레시피 클론 + GR00T 환경 설치     (5-10분)
Step 3: 데이터셋 준비                      (1분)
Step 4: 학습 실행 및 모니터링              (10-30분, MAX_STEPS에 따라)
Step 5: 결과 확인 및 추론 테스트           (5-10분)
  - 5.1~5.3: Open-loop 추론
  - 5.4: Closed-loop 시뮬레이션 (Isaac Sim)
Step 6: (선택) 노드 스케일링               (5-10분)
```

총 소요 시간: 약 30-70분 (GPU 노드가 이미 켜져 있는 경우)

> **Note:** GPU 노드를 스케일업하는 경우 추가로 5분 소요됩니다.
> 최초 CDK 배포 시 전체 인프라 생성에 약 10-15분이 소요됩니다.
