<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

SPDX-License-Identifier: Apache-2.0
-->

# Physical AI: 엔드투엔드 VLA Fine-tuning 파이프라인을 통한 Nut Pouring

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

## 개요

수집된 텔레오퍼레이션(Teleop) 데이터를 활용해 최신 로봇 정책을 학습하려는 개발자에게 엔드투엔드(E2E) 파이프라인 구현은 필수적입니다. 이 워크플로우는 원시 Teleop 데이터를 강력한 **GROOT-N1.5 Vision-Language-Action (VLA)** 모델의 학습 준비 형식으로 변환하도록 설계된 견고한 6단계 데이터 준비 및 증강 파이프라인을 제시합니다.

다단계 산업용 조작 워크플로우인 **Nut-Pouring Task Dataset**을 활용하여, foundation VLA 모델을 효과적으로 활용하는 데 필요한 전체 데이터 라이프사이클을 보여줍니다. 시연하는 핵심 데이터 파이프라인 단계는 다음과 같습니다:

- **MimicGen** - 합성 데모 생성
- **데이터 형식 변환** - HDF5 ↔ MP4 변환
- **Cosmos Transfer** - sim-to-real을 위한 시각적 증강
- **LeRobot 형식 변환** - 학습 준비 데이터셋 준비

파이프라인은 성공적인 GROOT-N1.5 fine-tuning 실행으로 마무리되어, 이 복잡한 cross-embodiment 아키텍처를 위한 데이터 준비 능력을 검증합니다. 이를 통해 NVIDIA OSMO를 사용하여 신뢰할 수 있는 E2E 데이터 파이프라인을 구축하고, 수집된 Teleop 데이터로 최신 VLA 모델을 빠르게 fine-tuning할 수 있는 명확하고 실행 가능한 로드맵을 제공합니다.

## 데이터 흐름

```text
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Teleop     │    │   Synthetic  │    │   Augmented  │    │   LeRobot    │
│    HDF5      │───▶│   Data Gen   │───▶│   Videos     │───▶│   Dataset    │
│              │    │   (HDF5)     │    │   (MP4)      │    │   (Parquet)  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                           │                   │                   │
                           │                   │                   │
                     MimicGen            Cosmos Transfer      GROOT Training
                     (100x demos)        (Sim-to-Real)        (Fine-tune)
```

## 파이프라인 단계

| 단계 | 워크플로우 | 설명 | 입력 | 출력 |
| ---- | -------- | ----------- | ----- | ------ |
| 1 | `01_mimic_generation.yaml` | 텔레오퍼레이션 데이터에서 합성 데모 생성 | Teleop HDF5 | 증강된 HDF5 |
| 2 | `02_hdf5_to_mp4.yaml` | 카메라 관측값을 MP4 형식으로 추출 | HDF5 | MP4 비디오 |
| 3 | `03_cosmos_augmentation.yaml` | 시각적 증강을 위한 Cosmos Transfer 2.5 적용 | MP4 | 증강된 MP4 |
| 4 | `04_mp4_to_hdf5.yaml` | 증강된 비디오를 HDF5에 병합 | MP4 | HDF5 |
| 5 | `05_lerobot_conversion.yaml` | LeRobot 데이터셋 형식으로 변환 | HDF5 | LeRobot Dataset |
| 6 | `06_groot_finetune.yaml` | GROOT-N1.5-3B 모델 fine-tuning | LeRobot Dataset | Fine-tuned Model |

> **참고:** 각 단계는 이전 단계에서 생성된 데이터에 의존하므로 이 워크플로우는 순차적으로 실행해야 합니다.

## 사전 요구 사항

- OSMO CLI 설치 및 인증 완료
- GPU 리소스가 있는 OSMO 클러스터 접근 권한 (RTX 6000 권장)
- GROOT 모델 접근을 위한 NGC API 키

## 파이프라인 실행

데이터셋에 접근하기 위해 Huggingface 자격증명을 설정합니다:

```bash
osmo credential set huggingface_token --type GENERIC --payload token=<your-hf-token>
```

첫 번째 입력 데이터셋을 설정합니다:

```bash
mkdir -p input_mimic
curl -O https://download.isaacsim.omniverse.nvidia.com/isaaclab/dataset/dataset_annotated_gr1_nut_pouring.hdf5
osmo dataset upload PhysAI-InputMimic dataset_annotated_gr1_nut_pouring.hdf5
```

각 단계를 순차적으로 실행합니다:

```bash
mkdir -p nut_pouring && cd nut_pouring
curl https://codeload.github.com/NVIDIA/OSMO/tar.gz/main | tar -xz --strip=4 OSMO-main/cookbook/nut_pouring

# Step 1: MimicGen 데이터 생성
osmo workflow submit 01_mimic_generation.yaml

# Step 2: HDF5에서 MP4로 변환
osmo workflow submit 02_hdf5_to_mp4.yaml

# Step 3: Cosmos Transfer 증강
osmo workflow submit 03_cosmos_augmentation.yaml

# Step 4: MP4에서 HDF5로 변환
osmo workflow submit 04_mp4_to_hdf5.yaml

# Step 5: LeRobot 형식 변환
osmo workflow submit 05_lerobot_conversion.yaml

# Step 6: GROOT fine-tuning
osmo workflow submit 06_groot_finetune.yaml
```

## 설정

각 워크플로우는 매개변수화된 기본값을 사용합니다. 필요에 따라 오버라이드하십시오:

```bash
osmo workflow submit 06_groot_finetune.yaml \
  --set max_steps=20000 \
  --set batch_size=64
```

## 참고 자료

- [GROOT-N1.5 Documentation](https://developer.nvidia.com/groot)
- [Cosmos Transfer](https://developer.nvidia.com/cosmos)
- [LeRobot](https://huggingface.co/lerobot)
