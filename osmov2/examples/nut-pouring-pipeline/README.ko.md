# Nut Pouring Pipeline

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

NVIDIA OSMO 업스트림 nut pouring cookbook의 AWS OSMO 재현. 단일 워크플로우가 아닌 다단계 파이프라인입니다. MimicGen이 합성 데모를 생성하고, Isaac Lab이 HDF5를 MP4로 변환하며, Cosmos Transfer가 카메라 스트림을 증강하고, Isaac Lab이 증강된 비디오를 다시 HDF5로 변환한 뒤, 데이터셋을 LeRobot 형식으로 변환하고, GR00T-N1.5를 fine-tuning합니다.

업스트림 소스:

- <https://github.com/NVIDIA/OSMO/tree/main/cookbook/nut_pouring>
- 고정 ref: `c2c30e55f84969fff55d51cd2044a03d40d6a1a5`

파일:

- [workflows/](workflows/): 준비된 6단계 OSMO 워크플로우 세트.
- [workflows/README.md](workflows/README.md): NVIDIA OSMO에서 복사한 업스트림 cookbook README.
- [validation.md](validation.md): 검증 결과, 런타임 메모, 플롯, 보존된 아티팩트 참조.
- [validation/](validation/): git에 보존된 소형 시각 및 메트릭 아티팩트.

## Adaptation Notes

<https://github.com/NVIDIA/OSMO/tree/main/cookbook/nut_pouring>의
`NVIDIA/OSMO@c2c30e55f84969fff55d51cd2044a03d40d6a1a5`에서 적용하였으며, 다음 변경 사항이 있습니다:

- AWS 레퍼런스 아키텍처의 `g7e-rtx-pro-6000` OSMO 플랫폼과 200Gi ephemeral storage를 대상으로 설정;
- OSMO 6.2 데이터셋 단축 표기 및 마운트된 데이터셋 경로 정규화;
- step 1의 업스트림 인터랙티브 `sleep infinity` 홀드 제거;
- Cosmos 컨테이너 로그인 시 Hugging Face 토큰이 출력되지 않도록 처리;
- Cosmos Transfer checkout 및 Cosmos Predict 토크나이저 revision 고정;
- `mp4_to_hdf5.py` 실행 전 Cosmos 출력 MP4를 Isaac Lab의 `demo_{id}_*.mp4` 규칙으로 평탄화;
- 업스트림 변환기는 `obs/eef_pos`를 기대하지만 GR1 데이터셋은 `left_eef_pos`와 `right_eef_pos`를 저장하므로 GR1 인식 MP4-to-HDF5 헬퍼 사용;
- LeRobot 변환을 위한 GR00T 의존성 설치 후 Isaac Lab `pip` 복구;
- Blackwell/G7e용 CUDA 12.8 PyTorch wheels 및 SDPA attention fallback 사용;
- GR00T 학습 GPU 메트릭, TensorBoard loss, 실행 매니페스트 수집 및 출력 데이터셋에 학습 checkpoint 보존.

저장소 루트에서 실행:

```bash
TF_OUTPUT_AWS_REGION=ap-northeast-2 \
TF_OUTPUT_CLUSTER_NAME=aws-osmo-dev-repro-eks \
TF_OUTPUT_OSMO_NAMESPACE=osmo \
TF_OUTPUT_OSMO_WORKLOAD_NAMESPACE=osmo-workflows \
TF_OUTPUT_OSMO_RUNTIME_SECRET_ARN='aws-osmo-dev-repro/osmo/runtime' \
NUT_POURING_SKIP_DATASET_UPLOAD=true \
NUT_POURING_START_STEP=4 \
NUT_POURING_PREWARM_INSTANCE_TYPE=g7e.24xlarge \
NUT_POURING_GPU_METRICS_INTERVAL_SECONDS=10 \
HF_TOKEN_FILE="$HOME/.huggingface/token" \
scripts/run-nut-pouring.sh
```

원본 텔레오퍼레이션 HDF5 업로드부터 최종 GR00T fine-tuning까지 전체를 실행하려면 `NUT_POURING_START_STEP=1`을 사용하십시오. 커밋된 검증은 step 4부터 시작하는데, 이는 stage 1-3 데이터셋이 이전 nut pouring 재현 작업에서 이미 존재했고 stage 3는 긴 Cosmos Transfer 워크로드이기 때문입니다.

래퍼는 가능한 한 업스트림 cookbook 동작을 그대로 유지합니다. AWS OSMO 준비 레이어는 위에 나열된 호환성 및 증거 수집 변경 사항만 적용합니다.

`NUT_POURING_PREPARE_ONLY=true` 및 `NUT_POURING_PREPARED_WORKFLOWS_DIR=...`을 사용하면 작업을 제출하지 않고 준비된 워크플로우 세트를 갱신할 수 있습니다.
