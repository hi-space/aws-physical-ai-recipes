# Parallel Eval

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

네 개의 CPU 평가 샤드를 팬아웃하고 해당 메트릭을 집계하는 소규모 OSMO `groups` 예제입니다.

레포 래퍼를 통해 실행하세요:

```bash
WORKFLOW_FILE=examples/parallel-eval/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=120 \
  scripts/smoke-test.sh
```

검증:

- [validation.md](validation.md)
- 신규 실행: `aws-physical-ai-parallel-eval-3`
- 관측된 실행 시간: `67s`
- 예상 완료 시간: 워밍업된 플랫폼 기준 `2-3 min`
- 출력 데이터셋: `aws-osmo/aws-physical-ai-parallel-eval-summary:2`

이 예제는 워크플로우 형태(shape) 예제입니다. 외부 데이터 없이 OSMO 팬아웃/팬인 동작을
검증할 수 있도록 합성 메트릭을 사용합니다.
