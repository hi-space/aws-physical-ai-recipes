# Lyra-2.0 DMD Single Sample

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

고정된 업스트림 소스 및 모델 ref를 사용하는 Lyra-2.0 DMD 단일 샘플 생성과
Gaussian-scene 트라젝터리 렌더링 워크플로우입니다.

파일:

- [workflow.yaml](workflow.yaml): OSMO 워크플로우 정의.
- [validation.md](validation.md): 완료된 검증 실행 및 시각적 산출물.
- [validation/](validation/): 보존된 입력, MP4 출력, GIF 미리보기, 컨택트 시트, 매니페스트.

검증 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  SMOKE_SET_HF_CREDENTIAL=true \
  HF_TOKEN_FILE="$HOME/.huggingface/token" \
  WORKFLOW_FILE=examples/lyra2-dmd-single/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=1440 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

Lyra는 `nvidia/Lyra-2.0`에 대한 Hugging Face 접근이 필요합니다. 스테이지-2
VIPE/DA3 재구성 경로는 깊이 및 지오메트리 지원을 위해 MoGe를 임포트하므로,
워크플로우는 Lyra 레포지터리와 별개로 `microsoft/MoGe`를 고정합니다.
기본 검증 시 생성된 PLY 파일은 업로드 전 삭제되고 MP4 출력과 매니페스트만 보존됩니다.
