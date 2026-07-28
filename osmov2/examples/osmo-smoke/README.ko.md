# OSMO Smoke

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

OSMO 컨트롤 플레인 및 백엔드를 위한 CPU 전용 스모크 워크플로우입니다.

레포 래퍼를 통해 실행하세요:

```bash
scripts/smoke-test.sh
```

래퍼는 [workflow.yaml](workflow.yaml)을 제출하고, 완료를 기다리며, 로그를 출력하고,
워크플로우가 완료되지 않으면 빠르게 실패합니다.

검증:

- [validation.md](validation.md)
