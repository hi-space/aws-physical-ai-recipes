# Sequential Policy

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

일반적인 정책 파이프라인 형태를 모델링하는 소규모 CPU/GPU/CPU 워크플로우입니다:
데이터셋 검사, GPU 정책 체크포인트 태스크 실행, 릴리스 산출물 패키징 순으로 진행합니다.

레포 래퍼를 통해 실행하세요:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/sequential-policy/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

검증:

- [validation.md](validation.md)
- 신규 실행: `aws-physical-ai-sequential-policy-2`
- 관측된 실행 시간: G7e 프리웜 이후 `116s`
- 예상 완료 시간: G7e 프로비저닝 및 정리 포함 `10-15 min`
- GPU: RTX PRO 6000 Blackwell, 드라이버 `580.126.09`, CUDA `13.0`

이 예제는 워크플로우 형태(shape) 예제입니다. 모델별 실행을 위해서는 GPU 태스크
본문을 실제 GR00T, OpenPI, 또는 Isaac Lab 학습 커맨드로 교체하세요.
