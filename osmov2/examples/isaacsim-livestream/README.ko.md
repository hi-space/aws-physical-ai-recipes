# Isaac Sim Livestream

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

livestreaming이 활성화된 인터랙티브 NVIDIA Isaac Sim 세션. 이 워크플로우는 G7e GPU 노드에서 Isaac Sim을 headless 모드로 실행하고 OSMO port-forward를 통해 렌더링 스트림을 노출합니다.

다섯 가지 워크플로우 파일을 제공합니다:

| 파일 | Isaac Sim | 플랫폼 | 메모리 | 비고 |
| --- | --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | `g7e-rtx-pro-6000` | 16Gi | e2e-workshop stable 프로필과 동일 |
| `workflow-5.1.yaml` | 5.1.0 (latest) | `g7e-rtx-pro-6000` | 32Gi | 더 큰 메모리 할당 (5.1 기본 요구량 증가) |
| `workflow-g6e.yaml` | 5.1.0 | `g6e-l40s` | 32Gi | G7e capacity 부족 시 폴백 (L40S 48GB) |
| `workflow-g6.yaml` | 4.5.0 | `g6-l4` | 16Gi | G7e·G6e 모두 부족할 때의 최후 폴백 (L4 24GB) |
| `workflow-g6-5.1-pubep.yaml` | 5.1.0 | `g6-l4` | 32Gi | 5.1 전용 `publicEndpointAddress`/`fixedHostPort` 지정 |

`platform`은 워크플로 파일에 고정되어 있고 템플릿 변수가 아니라서 `--set`으로 바꿀 수
없습니다. G6e에서 실행할 때는 `workflow-g6e.yaml`을 제출하십시오. 이 경로는
`DEPLOY_G6E_NODEPOOL=true`로 만든 `aws-osmo-g6e` NodePool과
`OSMO_CONFIGURE_G6E_PLATFORM=true`로 등록한 `g6e-l40s` 플랫폼이 둘 다 있어야 동작합니다.
하나만 있으면 실패합니다. G6도 같은 구조입니다 — `DEPLOY_G6_NODEPOOL=true`와
`OSMO_CONFIGURE_G6_PLATFORM=true`가 둘 다 필요합니다. 자세한 내용은
[docs/gpu-capacity.ko.md](../../docs/gpu-capacity.ko.md)를 참고하십시오.

`workflow-g6.yaml`은 stable 프로필을 그대로 내려받은 것이라 4.5.0을 씁니다. VRAM 때문은
아닙니다. 2026-09-15 L4(23034MiB)에서 실측한 유휴 GPU 메모리는 4.5.0이 577MiB, 5.1.0이
2032MiB로 둘 다 여유가 충분했습니다. L4에서 5.1을 쓰려면
[workflow-g6-5.1-pubep.yaml](workflow-g6-5.1-pubep.yaml)을 제출하십시오.

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

G7e가 `InsufficientInstanceCapacity`로 잡히지 않을 때는 G6e로 넘어갑니다.
`prewarm-gpu-node.sh`는 요청한 크기에 착륙하지 못하면 실패하므로, 크기를 고정하지 않는
probe로 노드를 확보하는 쪽이 확률이 높습니다
([docs/gpu-capacity.ko.md](../../docs/gpu-capacity.ko.md)의 "요청한 크기가 품절일 때
(ICE)" 절).

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6e.yaml
```

G6e도 안 잡히면 G6(L4)까지 내려갑니다. 2026-09-15 `us-east-1`에서는 g7e 전 크기와
g6e 전 크기가 닿을 수 있는 두 AZ에서 모두 품절인 상황에서 `g6.2xlarge`가 첫 시도에
떴습니다. L4는 24GB이므로 스트리밍·평가용이고 학습용은 아닙니다.

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

## 스트림 보기

`osmo workflow port-forward`로는 영상을 받을 수 없습니다. 2026-09-15에 종단 간으로 실측했고,
원인은 도구 버그가 아니라 구조적 제약입니다. 근거는 [validation.md](validation.md),
설명은 [docs/osmo-compatibility.md](../../docs/osmo-compatibility.md)에 있습니다.

요약하면 이렇습니다. Isaac Sim은 자기 인터페이스에서만 ICE 후보를 수집하므로 SDP에 pod의
VPC 주소를 실어 보냅니다. 포트 전달은 그 포트를 클라이언트의 `localhost`에 매핑하는데,
`localhost`는 SDP 어디에도 없으므로 검사할 유효한 후보 쌍이 없습니다. 시그널링은 연결되고
STUN 바인딩 요청은 터널을 왕복하지만, 연결 상태가 `checking`에서 `disconnected`로 넘어가고
디코딩된 프레임은 0입니다. 포트를 더 열어도 달라지지 않습니다.

클라이언트가 pod IP에 직접 도달해야 합니다. 주소는 이렇게 확인합니다.

```bash
kubectl -n osmo-workflows get pod <pod> -o jsonpath='{.status.podIP}'
```

그다음 노드 보안 그룹에서 클라이언트 출처에 대해 TCP `49100`과 UDP `47995-48012`,
`49000-49007`을 허용하고, Isaac Sim Streaming Client에서 그 pod IP를 지정합니다.
5.1.0에서는 `--/app/livestream/fixedHostPort=47998`로 미디어 포트를 고정할 수 있어
UDP는 그 한 포트만 열면 됩니다. pod IP를 라우팅 가능하게 만드는 방법은 두 가지입니다.

- 클러스터 VPC로 들어가는 VPN 또는 서브넷 라우터. 노트북을 클라이언트로 유지할 수 있습니다.
- VPC 내부의 GUI 데스크톱 인스턴스. 계정 안에서 완결되고 지연이 가장 적으며, 여러 사용자에게
  같은 절차를 주기 쉽습니다.

TURN 중계는 선택지가 아닙니다. Isaac Sim에는 ICE 서버 설정 자체가 없습니다. 이미지에 들어
있는 `libcarb.livestream-rtc.plugin.so`의 `/app/livestream/*` 키를 전수 확인한 결과
5.1.0은 20개, 4.5.0은 10개이고 어느 쪽에도 `iceServer`, `stunServer`, `turnServer`가
없습니다. Isaac Sim이 relay 후보를 수집하지 않으므로 VPC에 TURN 서버를 세워도 소용이
없습니다.

광고 주소를 바꿔도 포트 전달 경로는 살아나지 않습니다. Isaac Sim 5.1.0은
`--/app/livestream/publicEndpointAddress`를 받고, `127.0.0.1`로 지정하면 SDP에 실제로
`127.0.0.1:47998`이 실립니다. 그래도 ICE는 실패합니다. ICE는 요청이 떠난 것과 정확히 같은
5-tuple로 돌아온 STUN 응답만 인정하는데, UDP를 WebSocket으로 감싸 중계하면 출처 주소와
포트가 보존되지 않기 때문입니다. 2026-09-15에 클라이언트 1.0.6과 1.1.5로 실측했습니다.

시그널링 포트만 확인하는 용도로는 TCP 포트 전달이 동작합니다.

```bash
osmo workflow port-forward <workflow-id> stream --port 49100 --connect-timeout 300
```

`localhost:49100`에 평범한 `GET`을 보내 HTTP 501이 오면 스트리밍 서버가 올라온 것입니다.
참고로 `--udp`는 CLI 6.3.1에서 별도로 깨져 있습니다(Python 3.11의 `asyncio.wait`가 코루틴을
직접 받지 않음). 위 제약과 무관하게 그 플래그 자체가 먼저 실패합니다.

정리(Cleanup):

```bash
scripts/wait-gpu-node-cleanup.sh
```

참고 사항:

- 워크플로우 실행 타임아웃은 2시간입니다. 시뮬레이션은 타임아웃되거나 수동으로 취소(`osmo workflow cancel <workflow-id>`)할 때까지 유지됩니다.
- 포트 범위: `47995-48012` (앱 스트리밍), `49000-49007` (비디오), `49100` (제어).
  5.1.0은 `fixedHostPort`로 미디어 측을 한 포트로 줄일 수 있습니다.
- 2026-09-15 L4(23034MiB) 실측 유휴 GPU 메모리: 4.5.0은 577MiB, 5.1.0은 2032MiB.
  대형 에셋이 포함된 씬은 이보다 훨씬 많이 쓰므로, 유휴 사용량이 아니라 씬 기준으로
  인스턴스를 고르십시오.
