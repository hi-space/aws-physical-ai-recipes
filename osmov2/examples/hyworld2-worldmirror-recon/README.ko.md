# HY-World 2.0 WorldMirror Reconstruction

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

업스트림 `Dining_Table` 샘플과 고정된 소스/모델 ref를 사용하는 HY-World 2.0 WorldMirror 재구성 워크플로우입니다.

파일:

- [workflow.yaml](workflow.yaml): OSMO 워크플로우 정의.
- [validation.md](validation.md): 완료된 검증 실행 및 시각적 산출물.
- [validation/](validation/): 보존된 입력/출력 미리보기 및 실행 매니페스트.

검증 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/hyworld2-worldmirror-recon/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

기본 실행 시 `gaussians.ply`와 `points.ply`는 OSMO 데이터셋에 보관되지만,
이 레포지터리에는 경량 미리보기만 커밋됩니다.
