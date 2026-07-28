# Isaac Sim Livestream

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

livestreaming이 활성화된 인터랙티브 NVIDIA Isaac Sim 세션. 이 워크플로우는 G7e GPU 노드에서 Isaac Sim을 headless 모드로 실행하고 OSMO port-forward를 통해 렌더링 스트림을 노출합니다.

두 가지 워크플로우 파일을 제공합니다:

| 파일 | Isaac Sim | 메모리 | 비고 |
| --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | 16Gi | e2e-workshop stable 프로필과 동일 |
| `workflow-5.1.yaml` | 5.1.0 (latest) | 32Gi | 더 큰 메모리 할당 (5.1 기본 요구량 증가) |

Isaac Sim 5.0.0은 별도 워크플로우를 두지 않습니다. 5.0은 5.1로 빠르게 대체된
과도기 릴리스라, e2e-workshop과 동일하게 stable(4.5)/latest(5.1) 두 프로필만
유지합니다. 5.0에서 실행해야 한다면 `isaac_sim_image`를
`nvcr.io/nvidia/isaac-sim:5.0.0`으로 오버라이드하면 되지만(포트/`runheadless.sh`
경로는 5.1과 동일), 검증 대상은 아닙니다.

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh

# stable (Isaac Sim 4.5.0)
osmo workflow submit examples/isaacsim-livestream/workflow.yaml

# latest (Isaac Sim 5.1.0)
osmo workflow submit examples/isaacsim-livestream/workflow-5.1.yaml
```

태스크가 `Running` 상태가 되면 TCP 및 UDP port-forwarding을 위해 터미널 두 개를 엽니다:

```bash
osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007,49100 \
  --connect-timeout 300

osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007 \
  --udp \
  --connect-timeout 300
```

그런 다음 로컬 머신에서 Isaac Sim Streaming Client를 열고 `localhost`에 접속합니다.

정리(Cleanup):

```bash
scripts/wait-gpu-node-cleanup.sh
```

참고 사항:

- 워크플로우 실행 타임아웃은 2시간입니다. 시뮬레이션은 타임아웃되거나 수동으로 취소(`osmo workflow cancel <workflow-id>`)할 때까지 유지됩니다.
- 포트 범위: `47995-48012` (앱 스트리밍), `49000-49007` (비디오), `49100` (제어).
- Isaac Sim 4.5.0은 유휴 상태에서 약 12GB GPU 메모리가 필요하며, 5.1.0은 약 18GB가 필요합니다. 대형 에셋이 포함된 씬은 더 큰 인스턴스 타입이 필요할 수 있습니다.
