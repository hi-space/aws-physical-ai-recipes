# Cosmos Reason2 NIM

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

NVIDIA OSMO의 NIM 클라이언트/서버 패턴과 `nvidia/cosmos-reason2-2b`를 사용하는
Cosmos Reason2 VLM 워크플로우입니다.

파일:

- [workflow.yaml](workflow.yaml): OSMO 워크플로우 정의.
- [validation.md](validation.md): 완료된 검증 실행, 입력 미리보기, 프롬프트, 모델 출력.
- [validation/](validation/): 보존된 요청, 응답, 비디오 미리보기, 매니페스트 산출물.

로컬 NIM 검증 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/cosmos-reason2-nim/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

기본 로컬 서버 리소스에는 `g7e.4xlarge` 이상을 사용하세요. 서버는 `cpu: 12`,
`memory: 96Gi`, `storage: 256Gi`, `gpu: 1`을 요청합니다.

서버 태스크를 구동하는 대신 호스팅된 NIM을 호출하려면, `ngc-api-key`를 생성하고
다음과 같이 제출하세요:

```bash
osmo workflow submit examples/cosmos-reason2-nim/workflow.yaml \
  --pool default \
  --set external_nim_server_url=https://integrate.api.nvidia.com
```

워크플로우는 요청 JSON, 응답 JSON, 답변 텍스트, 실행 매니페스트를 업로드합니다.
검증 프롬프트는 Cosmos Reason2에게 입력 비디오를 로보틱스 데이터셋 포함 여부로
승인 또는 거부하고 간략한 근거를 포함하도록 요청합니다.
