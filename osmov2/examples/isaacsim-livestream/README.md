# Isaac Sim Livestream

Interactive NVIDIA Isaac Sim session with livestreaming enabled. The workflow launches Isaac Sim in headless mode on a G7e GPU node and exposes the rendering stream via OSMO port-forward.

Five workflow files are provided:

| File | Isaac Sim | Platform | Memory | Notes |
| --- | --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | `g7e-rtx-pro-6000` | 16Gi | e2e-workshop stable 프로필과 동일 |
| `workflow-5.1.yaml` | 5.1.0 (latest) | `g7e-rtx-pro-6000` | 32Gi | 더 큰 메모리 할당 (5.1 기본 요구량 증가) |
| `workflow-g6e.yaml` | 5.1.0 | `g6e-l40s` | 32Gi | G7e capacity 부족 시 fallback (L40S 48GB) |
| `workflow-g6.yaml` | 4.5.0 | `g6-l4` | 16Gi | G7e·G6e 모두 부족할 때의 최후 폴백 (L4 24GB) |
| `workflow-g6-5.1-pubep.yaml` | 5.1.0 | `g6-l4` | 32Gi | 5.1 전용 `publicEndpointAddress`/`fixedHostPort` 지정 |

`platform`은 워크플로 파일에 고정되어 있고 템플릿 변수가 아니라서 `--set`으로 바꿀 수
없습니다. G6e에서 실행할 때는 `workflow-g6e.yaml`을 제출하십시오. 이 경로는
`DEPLOY_G6E_NODEPOOL=true`로 만든 `aws-osmo-g6e` NodePool과
`OSMO_CONFIGURE_G6E_PLATFORM=true`로 등록한 `g6e-l40s` 플랫폼이 둘 다 있어야 동작합니다.
하나만 있으면 실패합니다. G6도 같은 구조입니다 — `DEPLOY_G6_NODEPOOL=true`와
`OSMO_CONFIGURE_G6_PLATFORM=true`가 둘 다 필요합니다. 자세한 내용은
[docs/gpu-capacity.md](../../docs/gpu-capacity.md)를 참고하십시오.

`workflow-g6.yaml`은 stable 프로필을 그대로 내려받은 것이라 4.5.0을 씁니다. VRAM 때문은
아닙니다. 2026-09-15 L4(23034MiB)에서 실측한 idle GPU 메모리는 4.5.0이 577MiB, 5.1.0이
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
([docs/gpu-capacity.md](../../docs/gpu-capacity.md)의 "When the size you asked for is
sold out (ICE)" 절).

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6e.yaml
```

G6e도 안 잡히면 G6(L4)까지 내려갑니다. 2026-09-15 `us-east-1`에서는 g7e 전 크기와
g6e 전 크기가 닿을 수 있는 두 AZ에서 모두 품절인 상황에서 `g6.2xlarge`가 첫 시도에
떴습니다. L4는 24GB이므로 스트리밍·평가용이고 학습용은 아닙니다.

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

## Viewing the stream

`osmo workflow port-forward` cannot carry the video. This was measured end-to-end on
2026-09-15, and the cause is architectural rather than a tooling bug — see
[validation.md](validation.md) for the evidence and
[docs/osmo-compatibility.md](../../docs/osmo-compatibility.md) for the write-up.

In short: Isaac Sim gathers ICE candidates only from the pod's own interface, so the SDP
it sends advertises the pod's VPC address. A port forwarder maps those ports onto the
client's `localhost`, an address that appears nowhere in the SDP, so ICE has no valid
candidate pair to check. Signalling connects, STUN binding requests cross the tunnel, and
then the connection goes `checking` -> `disconnected` with zero frames decoded. Forwarding
more ports does not change this.

The client has to reach the pod IP directly. Read it with:

```bash
kubectl -n osmo-workflows get pod <pod> -o jsonpath='{.status.podIP}'
```

Then allow the client's source in the node security group — TCP `49100` plus UDP
`47995-48012` and `49000-49007` — and point the Isaac Sim Streaming Client at that pod IP.
On 5.1.0, `--/app/livestream/fixedHostPort=47998` pins the media port, so a single UDP
port needs opening instead of the full ranges. Two ways to make the pod IP routable:

- A VPN or subnet router into the cluster VPC. Keeps a laptop as the client.
- A GUI desktop instance inside the VPC. Self-contained in the account, lowest latency,
  easiest to hand to several users.

A TURN relay is not an option. Isaac Sim exposes no ICE server setting at all — every
`/app/livestream/*` key in the shipped `libcarb.livestream-rtc.plugin.so` was enumerated
(20 keys on 5.1.0, 10 on 4.5.0) and neither set contains `iceServer`, `stunServer`, or
`turnServer`. A TURN server in the VPC would not help because Isaac Sim never gathers
relay candidates.

Overriding the advertised address does not rescue the port-forward path either. Isaac Sim
5.1.0 accepts `--/app/livestream/publicEndpointAddress`, and setting it to `127.0.0.1`
does put `127.0.0.1:47998` in the SDP — but ICE still fails, because ICE only accepts a
STUN response that returns on the exact 5-tuple the request left from, and tunnelling UDP
through a WebSocket relay does not preserve the source address and port. Measured on
2026-09-15 with clients 1.0.6 and 1.1.5.

The signalling port on its own is still useful for a liveness check, and TCP port-forward
does work for that:

```bash
osmo workflow port-forward <workflow-id> stream --port 49100 --connect-timeout 300
```

A plain `GET` to `localhost:49100` returning HTTP 501 means the streaming server is up.
Note that `--udp` is separately broken in CLI 6.3.1 (`asyncio.wait` rejects bare
coroutines on Python 3.11), so that flag fails before any of the above applies.

Cleanup:

```bash
scripts/wait-gpu-node-cleanup.sh
```

Notes:

- The workflow has a 2h execution timeout. The sim stays alive until timeout or manual cancellation (`osmo workflow cancel <workflow-id>`).
- Port ranges: `47995-48012` (app streaming), `49000-49007` (video), `49100` (control).
  5.1.0 can collapse the media side to one port with `fixedHostPort`.
- Idle GPU memory measured on L4 (23034MiB) on 2026-09-15: 577MiB on 4.5.0, 2032MiB on
  5.1.0. Scenes with large assets need much more, so size the instance for the scene
  rather than for the idle sim.
- Isaac Sim 4.5.0 on G7e (RTX PRO 6000 Blackwell) logs `CUDA compute capability 12.0
  is unsupported by this version of iray photoreal`. 4.5.0 predates Blackwell, so its
  bundled iray does not recognize compute capability 12.0. iray photoreal is the
  offline photoreal renderer, not the real-time RTX + NVENC path WebRTC streaming
  uses, so the warning is not by itself proof that streaming is broken — but prefer
  5.1.0 or newer on Blackwell. This has not been isolated on a live G7e node here.
