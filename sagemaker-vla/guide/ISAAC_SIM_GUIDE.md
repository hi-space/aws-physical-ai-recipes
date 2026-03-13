# Isaac Sim 연동 데이터 수집 가이드

## 1. 개요

이 가이드는 NVIDIA Isaac Sim에서 로봇 시뮬레이션 데이터를 수집하고,
LeRobot v2 형식으로 변환하여 GR00T-N1.6 파인튜닝에 사용하는 워크플로우를 설명합니다.

### 왜 Isaac Sim인가?

| 비교 항목 | Isaac Sim | Gazebo | MuJoCo |
|-----------|-----------|--------|--------|
| GR00T 호환성 | ✅ 공식 지원 | ❌ 별도 변환 필요 | ⚠️ 부분 지원 |
| 렌더링 품질 | RTX 레이트레이싱 | 기본 OpenGL | 기본 렌더링 |
| LeRobot 변환 | 공식 도구 제공 | 수동 구현 | 커뮤니티 도구 |
| GPU 가속 물리 | PhysX 5 (GPU) | ODE/Bullet (CPU) | MuJoCo (CPU) |
| 설치 복잡도 | 높음 (50GB+) | 중간 | 낮음 |

GR00T-N1.6은 NVIDIA 생태계 모델이므로, Isaac Sim과의 연동이 가장 자연스럽고
공식 문서와 도구가 잘 갖춰져 있습니다.


---

## 2. 사전 요구사항

### 2.1 하드웨어

- **GPU**: NVIDIA RTX 3070 이상 (VRAM 8GB+, RTX 4080+ 권장)
- **RAM**: 32GB 이상
- **디스크**: 100GB 이상 여유 공간 (Isaac Sim ~50GB + 데이터)
- **OS**: Ubuntu 22.04 LTS 또는 Windows 10/11

### 2.2 소프트웨어

- **NVIDIA 드라이버**: 535.129+ (CUDA 12.2 호환)
- **Isaac Sim 4.2+**: [NVIDIA Omniverse](https://developer.nvidia.com/isaac-sim)에서 설치
- **Python 3.10**
- **Isaac-GR00T**: 데이터 변환 도구 포함

```bash
# Isaac-GR00T 설치
git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git
cd Isaac-GR00T
pip install -e ".[train]"
```

---

## 3. 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    Isaac Sim                             │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│  │ 로봇 USD │  │ 환경 USD │  │ 텔레오퍼레이션     │    │
│  │ (Franka) │  │ (테이블) │  │ / 스크립트 제어    │    │
│  └────┬─────┘  └────┬─────┘  └─────────┬──────────┘    │
│       └──────────────┴──────────────────┘               │
│                      │                                   │
│              OmniGraph / Replicator                      │
│              (센서 데이터 수집)                           │
│                      │                                   │
│         ┌────────────┼────────────┐                      │
│         ▼            ▼            ▼                      │
│    RGB 이미지    관절 상태     액션 로그                  │
└─────────┬────────────┬────────────┬─────────────────────┘
          │            │            │
          ▼            ▼            ▼
   ┌──────────────────────────────────────┐
   │     Isaac-GR00T 변환 도구            │
   │     (raw → LeRobot v2 형식)          │
   └──────────────────┬───────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │     LeRobot v2 데이터셋              │
   │     ├── meta/info.json               │
   │     ├── data/chunk-000/*.parquet     │
   │     └── videos/chunk-000/*.mp4       │
   └──────────────────┬───────────────────┘
                      │
                      ▼
              S3 업로드 → SageMaker 학습
```


---

## 4. 단계별 워크플로우

### Step 1: Isaac Sim 설치 및 환경 구성

```bash
# 1. NVIDIA Omniverse Launcher 설치
# https://www.nvidia.com/en-us/omniverse/download/ 에서 다운로드

# 2. Omniverse Launcher에서 Isaac Sim 4.2+ 설치

# 3. Isaac Sim Python 환경 확인
~/.local/share/ov/pkg/isaac-sim-4.2.0/python.sh -c "import omni; print('Isaac Sim OK')"
```

### Step 2: 로봇 및 환경 USD 설정

Isaac Sim에서 시뮬레이션 환경을 구성합니다.

```python
# isaac_sim_setup.py
# Isaac Sim의 standalone Python 스크립트로 실행

from isaacsim import SimulationApp
simulation_app = SimulationApp({"headless": False})  # GUI 모드

import omni
from omni.isaac.core import World
from omni.isaac.core.robots import Robot
from omni.isaac.core.objects import DynamicCuboid

# 월드 생성
world = World(stage_units_in_meters=1.0)

# 로봇 로드 (Franka Panda 예시)
robot = world.scene.add(
    Robot(
        prim_path="/World/Franka",
        name="franka",
        usd_path="omniverse://localhost/NVIDIA/Assets/Isaac/Robots/Franka/franka.usd",
        position=[0, 0, 0],
    )
)

# 조작 대상 물체
cube = world.scene.add(
    DynamicCuboid(
        prim_path="/World/Cube",
        name="target_cube",
        position=[0.4, 0.0, 0.05],
        size=0.05,
        color=[1.0, 0.0, 0.0],  # 빨간색
    )
)

world.reset()
print("환경 설정 완료")
```

### Step 3: 데이터 수집 스크립트

시뮬레이션을 실행하면서 RGB 이미지, 관절 상태, 액션을 기록합니다.

```python
# collect_data.py
import numpy as np
import json
import os
from datetime import datetime

class IsaacSimDataCollector:
    """Isaac Sim에서 로봇 조작 데이터를 수집하는 클래스."""

    def __init__(self, output_dir, robot, camera, fps=10):
        self.output_dir = output_dir
        self.robot = robot
        self.camera = camera
        self.fps = fps
        self.episodes = []
        self.current_episode = []

        os.makedirs(f"{output_dir}/raw", exist_ok=True)

    def start_episode(self):
        """새 에피소드 시작."""
        self.current_episode = []
        print(f"에피소드 {len(self.episodes)} 시작")

    def record_step(self, action):
        """한 타임스텝의 데이터를 기록."""
        # RGB 이미지 캡처
        rgb = self.camera.get_rgba()[:, :, :3]  # RGBA → RGB

        # 로봇 관절 상태 (고유수용감각)
        joint_positions = self.robot.get_joint_positions()
        joint_velocities = self.robot.get_joint_velocities()

        self.current_episode.append({
            "timestamp": len(self.current_episode) / self.fps,
            "rgb": rgb,
            "joint_positions": joint_positions.tolist(),
            "joint_velocities": joint_velocities.tolist(),
            "action": action.tolist(),
        })

    def end_episode(self):
        """에피소드 종료 및 저장."""
        ep_idx = len(self.episodes)
        ep_dir = f"{self.output_dir}/raw/episode_{ep_idx:06d}"
        os.makedirs(ep_dir, exist_ok=True)

        # 프레임별 데이터 저장
        for i, step in enumerate(self.current_episode):
            # RGB 이미지 저장
            from PIL import Image
            img = Image.fromarray(step["rgb"])
            img.save(f"{ep_dir}/frame_{i:06d}.png")

            # 상태/액션은 JSON으로 저장
            meta = {k: v for k, v in step.items() if k != "rgb"}
            with open(f"{ep_dir}/frame_{i:06d}.json", "w") as f:
                json.dump(meta, f)

        self.episodes.append({
            "episode_index": ep_idx,
            "length": len(self.current_episode),
        })
        print(f"에피소드 {ep_idx} 저장 완료: {len(self.current_episode)} 프레임")
        self.current_episode = []
```


### Step 4: 데이터 수집 실행

텔레오퍼레이션(사람이 직접 조작) 또는 스크립트 제어로 데이터를 수집합니다.

```python
# run_collection.py
# Isaac Sim standalone 스크립트로 실행:
#   ~/.local/share/ov/pkg/isaac-sim-4.2.0/python.sh run_collection.py

from isaacsim import SimulationApp
simulation_app = SimulationApp({"headless": True})  # headless 모드 (서버용)

import numpy as np
from omni.isaac.core import World

# ... (Step 2의 환경 설정 코드) ...

# 카메라 설정
from omni.isaac.sensor import Camera
camera = Camera(
    prim_path="/World/Camera",
    position=[0.8, 0.0, 0.6],
    frequency=10,
    resolution=(224, 224),
)

# 데이터 수집기 초기화
collector = IsaacSimDataCollector(
    output_dir="/tmp/isaac_sim_data",
    robot=robot,
    camera=camera,
    fps=10,
)

# 에피소드 수집 루프
NUM_EPISODES = 50
STEPS_PER_EPISODE = 100

for ep in range(NUM_EPISODES):
    world.reset()
    collector.start_episode()

    for step in range(STEPS_PER_EPISODE):
        # 스크립트 제어 예시: 큐브를 향해 이동
        # 실제로는 텔레오퍼레이션 또는 RL 정책으로 대체
        target_pos = cube.get_world_pose()[0]
        ee_pos = robot.get_world_pose()[0]
        action = np.clip((target_pos - ee_pos) * 2.0, -0.5, 0.5)
        action = np.append(action, [0, 0, 0, 0.8])  # 7-DoF로 패딩

        # 액션 적용
        robot.apply_action(action[:7])
        world.step(render=True)

        # 데이터 기록
        collector.record_step(action[:7])

    collector.end_episode()

print(f"수집 완료: {NUM_EPISODES} 에피소드")
simulation_app.close()
```

### Step 5: LeRobot v2 형식으로 변환

Isaac-GR00T에 포함된 변환 도구를 사용하여 수집된 raw 데이터를 LeRobot v2 형식으로 변환합니다.

```python
# convert_to_lerobot.py
import os
import json
import numpy as np
import pandas as pd
from PIL import Image
from pathlib import Path

def convert_isaac_to_lerobot(raw_dir, output_dir, robot_type="franka"):
    """Isaac Sim raw 데이터를 LeRobot v2 형식으로 변환.

    Args:
        raw_dir: Isaac Sim 수집 데이터 경로 (raw/ 디렉토리)
        output_dir: LeRobot v2 데이터셋 출력 경로
        robot_type: 로봇 종류 식별자
    """
    # 출력 디렉토리 구조 생성
    for subdir in ["meta", "data/chunk-000", "videos/chunk-000"]:
        os.makedirs(f"{output_dir}/{subdir}", exist_ok=True)

    episodes = sorted(Path(raw_dir).glob("episode_*"))
    episodes_meta = []
    all_stats = {"observation.state": [], "action": []}

    for ep_dir in episodes:
        ep_idx = int(ep_dir.name.split("_")[1])
        frames = sorted(ep_dir.glob("frame_*.json"))

        rows = []
        video_dir = f"{output_dir}/videos/chunk-000/episode_{ep_idx:06d}"
        os.makedirs(video_dir, exist_ok=True)

        for frame_file in frames:
            frame_idx = int(frame_file.stem.split("_")[1])

            # JSON 메타데이터 로드
            with open(frame_file) as f:
                meta = json.load(f)

            # 이미지 복사
            img_src = frame_file.with_suffix(".png")
            if img_src.exists():
                img = Image.open(img_src)
                img.save(f"{video_dir}/frame_{frame_idx:06d}.png")

            state = meta["joint_positions"]
            action = meta["action"]

            rows.append({
                "episode_index": ep_idx,
                "frame_index": frame_idx,
                "timestamp": meta["timestamp"],
                "observation.state": state,
                "action": action,
            })

            all_stats["observation.state"].append(state)
            all_stats["action"].append(action)

        # Parquet 저장
        df = pd.DataFrame(rows)
        df.to_parquet(
            f"{output_dir}/data/chunk-000/episode_{ep_idx:06d}.parquet",
            index=False,
        )

        episodes_meta.append({
            "episode_index": ep_idx,
            "length": len(frames),
        })

    # meta/info.json
    state_dim = len(all_stats["observation.state"][0])
    action_dim = len(all_stats["action"][0])

    info = {
        "codebase_version": "v2.0",
        "robot_type": robot_type,
        "total_episodes": len(episodes),
        "total_frames": sum(ep["length"] for ep in episodes_meta),
        "fps": 10,
        "features": {
            "observation.images.top": {
                "dtype": "image",
                "shape": [224, 224, 3],
                "names": ["height", "width", "channels"],
            },
            "observation.state": {
                "dtype": "float32",
                "shape": [state_dim],
                "names": ["state"],
            },
            "action": {
                "dtype": "float32",
                "shape": [action_dim],
                "names": ["action"],
            },
        },
    }

    with open(f"{output_dir}/meta/info.json", "w") as f:
        json.dump(info, f, indent=2)

    # meta/episodes.jsonl
    with open(f"{output_dir}/meta/episodes.jsonl", "w") as f:
        for ep in episodes_meta:
            f.write(json.dumps(ep) + "\n")

    # meta/stats.json
    states = np.array(all_stats["observation.state"])
    actions = np.array(all_stats["action"])

    stats = {
        "observation.state": {
            "mean": states.mean(axis=0).tolist(),
            "std": states.std(axis=0).tolist(),
            "min": states.min(axis=0).tolist(),
            "max": states.max(axis=0).tolist(),
        },
        "action": {
            "mean": actions.mean(axis=0).tolist(),
            "std": actions.std(axis=0).tolist(),
            "min": actions.min(axis=0).tolist(),
            "max": actions.max(axis=0).tolist(),
        },
    }

    with open(f"{output_dir}/meta/stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print(f"변환 완료: {len(episodes)} 에피소드 → {output_dir}")


# 실행
convert_isaac_to_lerobot(
    raw_dir="/tmp/isaac_sim_data/raw",
    output_dir="/tmp/isaac_sim_lerobot_dataset",
    robot_type="franka",
)
```


### Step 6: S3 업로드 및 SageMaker 파이프라인 연결

변환된 데이터셋을 S3에 업로드하면 기존 노트북 파이프라인에서 바로 사용할 수 있습니다.

```bash
# LeRobot v2 데이터셋을 S3에 업로드
aws s3 cp --recursive \
    /tmp/isaac_sim_lerobot_dataset \
    s3://your-bucket/groot-n16/datasets/isaac-sim-franka/

# 노트북에서 사용할 때:
# S3_DATASET_URI = 's3://your-bucket/groot-n16/datasets/isaac-sim-franka'
```

노트북의 Step 1.2에서 `S3_DATASET_URI`를 위 경로로 변경하면 됩니다.

---

## 5. Isaac-GR00T 공식 변환 도구 사용

Isaac-GR00T 리포지토리에는 다양한 소스의 데이터를 LeRobot v2로 변환하는 공식 도구가 포함되어 있습니다.

```bash
# Isaac-GR00T 리포지토리 클론
git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git
cd Isaac-GR00T

# 데이터 변환 도구 확인
ls gr00t/data/

# 공식 변환 스크립트 실행 예시
python gr00t/data/convert_to_lerobot.py \
    --input-dir /tmp/isaac_sim_data/raw \
    --output-dir /tmp/lerobot_dataset \
    --robot-type franka \
    --fps 10
```

자세한 내용은 [Isaac-GR00T 공식 문서](https://github.com/NVIDIA/Isaac-GR00T)를 참고하세요.

---

## 6. Headless 모드 (서버 환경)

GPU가 있는 서버에서 모니터 없이 데이터를 수집할 수 있습니다.

```bash
# headless 모드로 Isaac Sim 실행
~/.local/share/ov/pkg/isaac-sim-4.2.0/python.sh \
    run_collection.py \
    --headless \
    --num-episodes 100

# Docker로 실행 (권장)
docker run --gpus all --rm \
    -v /tmp/isaac_sim_data:/output \
    nvcr.io/nvidia/isaac-sim:4.2.0 \
    python /workspace/run_collection.py --headless
```

### AWS에서 실행

EC2 GPU 인스턴스(g5, p4d 등)에서 headless 모드로 대규모 데이터 수집이 가능합니다.

```bash
# EC2 g5.xlarge에서 실행 예시
# 1. NVIDIA 드라이버 + Isaac Sim 설치
# 2. headless 모드로 데이터 수집
# 3. 수집된 데이터를 S3에 직접 업로드

python run_collection.py --headless --num-episodes 500
aws s3 cp --recursive /tmp/isaac_sim_lerobot_dataset s3://bucket/datasets/
```

---

## 7. 트러블슈팅

### Isaac Sim 설치 실패

```
Error: Failed to load Omniverse Kit
```

- NVIDIA 드라이버 버전 확인: `nvidia-smi` (535.129+ 필요)
- Vulkan 지원 확인: `vulkaninfo | head -20`
- 디스크 공간 확인: Isaac Sim은 ~50GB 필요

### 렌더링 오류 (headless)

```
Error: No display available
```

- `--headless` 플래그 확인
- EGL 렌더링 사용: `export DISPLAY=` (빈 값으로 설정)
- Docker 사용 시 `--gpus all` 플래그 필수

### 데이터 변환 오류

```
Error: Mismatched action dimensions
```

- 로봇의 DoF와 액션 차원이 일치하는지 확인
- Franka Panda: 7-DoF (+ gripper = 8)
- `embodiment_tag`가 데이터셋의 `robot_type`과 일치하는지 확인

### 메모리 부족

```
Error: CUDA out of memory
```

- 해상도 낮추기: `resolution=(128, 128)` → 학습 시 리사이즈
- 동시 렌더링 카메라 수 줄이기
- `--headless` 모드 사용 (GUI 렌더링 비용 제거)

---

## 8. 참고 자료

- [Isaac Sim 공식 문서](https://docs.omniverse.nvidia.com/isaacsim/latest/)
- [Isaac-GR00T GitHub](https://github.com/NVIDIA/Isaac-GR00T)
- [LeRobot 프로젝트](https://github.com/huggingface/lerobot)
- [NVIDIA Omniverse](https://developer.nvidia.com/omniverse)
- [GR00T-N1.6 SageMaker 파이프라인 노트북](../notebook/groot_n16_sagemaker_pipeline.ipynb)
