# Isaac Sim Livestream

Interactive NVIDIA Isaac Sim session with livestreaming enabled. The workflow launches
Isaac Sim in headless mode on a GPU node and serves a WebRTC stream from the workload pod.

## Scope

This example covers two things:

1. Bringing an Isaac Sim streaming server up on an OSMO-provisioned GPU node and verifying
   it. Runtime-validated on `g6`/L4 — see [validation.md](validation.md).
2. Viewing that stream **from a client inside the cluster VPC**, which is the only
   configuration in which video actually arrives.

It does not cover viewing the stream from a client outside the VPC. `osmo workflow
port-forward` cannot carry WebRTC media, and no amount of port mapping changes that — the
measurements and the reason are in [Viewing the stream](#viewing-the-stream). Plan for a
VPN into the VPC or a GUI desktop instance inside it before promising anyone a stream.

Six workflow files are provided:

| File | Isaac Sim | Platform | Memory | Notes |
| --- | --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | `g7e-rtx-pro-6000` | 16Gi | Same as the e2e-workshop stable profile |
| `workflow-5.1.yaml` | 5.1.0 (latest) | `g7e-rtx-pro-6000` | 32Gi | Larger allocation; 5.1 needs more by default |
| `workflow-g6e.yaml` | 5.1.0 | `g6e-l40s` | 32Gi | Fallback when G7e capacity is short (L40S 48GB) |
| `workflow-g6.yaml` | 4.5.0 | `g6-l4` | 16Gi | Last fallback when both G7e and G6e are short (L4 24GB) |
| `workflow-g6-5.1-pubep.yaml` | 5.1.0 | `g6-l4` | 32Gi | 5.1-only `publicEndpointAddress`/`fixedHostPort` probe |
| `workflow-g6-5.1-scene.yaml` | 5.1.0 | `g6-l4` | 32Gi | Physics scene at 1920x1080, re-drops so it keeps moving |

Submit `workflow-g6-5.1-scene.yaml` when a person is going to look at the stream. The other
files start a streaming server with an empty stage, which is fine for verifying the server
but indistinguishable from a broken stream to a viewer.

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

## Verifying the server is up

This works from anywhere and is the right first step, because it separates a server problem
from a connectivity problem. TCP port-forward to the signalling port is transparent:

```bash
osmo workflow port-forward <workflow-id> stream --port 49100 --connect-timeout 300
```

A plain `GET` to `localhost:49100` returning HTTP 501 means the streaming server is up.
4.5.0 takes roughly 8m30s to reach that state on L4; 5.1.0 takes about 63s.

Do not pass `--udp`. It is broken in CLI 6.3.1 (`asyncio.wait` rejects bare coroutines on
Python 3.11), and it would not help anyway — see below.

## Viewing the stream

The client must be inside the cluster VPC, because it has to reach the pod IP directly.
Read the address with:

```bash
scripts/get-workflow-pod-ip.sh <workflow-id>
```

That resolves the workflow ID to the pod IP and needs only `get pods` in the workload
namespace, so a viewing desktop does not need cluster-wide `kubectl`. Set
`OSMO_WORKLOAD_NAMESPACE` on that desktop to skip the Terraform state lookup. The
underlying call is:

```bash
kubectl -n osmo-workflows get pod <pod> -o jsonpath='{.status.podIP}'
```

Then allow the client's source in the node security group — TCP `49100` plus UDP
`47995-48012` and `49000-49007` — and point the Isaac Sim Streaming Client at that pod IP.
On 5.1.0, `--/app/livestream/fixedHostPort=47998` pins the media port, so only that one
UDP port needs opening. Two ways to put the client inside the VPC:

- A GUI desktop instance in the VPC. Self-contained in the account, lowest latency, and the
  easiest to hand to several users. `scripts/deploy-viewer-desktop.sh` builds one — an
  Ubuntu 24.04 DLAMI `g6.2xlarge` with Amazon DCV and the Isaac Sim WebRTC Streaming
  Client, plus the node security group rules that let it reach the pod:

  ```bash
  DCV_ALLOWED_CIDR="$(curl -s https://checkip.amazonaws.com)/32" \
  DCV_DESKTOP_PASSWORD='<pick one>' \
    scripts/deploy-viewer-desktop.sh
  ```

  Connect to `https://<public-ip>:8443` and run the streaming client there. The desktop is
  a GPU instance that bills until terminated: `scripts/deploy-viewer-desktop.sh --destroy`.
- A VPN or subnet router into the VPC. Keeps a laptop as the client, but needs per-user
  setup.

### Putting something in the viewport

A bare streaming app shows an empty stage, which is indistinguishable from a broken stream.
Load a scene through the same launcher instead of writing a separate Python entrypoint:

```bash
./runheadless.sh \
  --/app/livestream/enabled=true \
  --/app/livestream/port=49100 \
  --/app/livestream/fixedHostPort=47998 \
  --exec /tmp/scene.py
```

`runheadless.sh` passes unrecognised arguments to kit, so `--exec` runs the scene inside the
streaming app that is already known to work.

Do not build the scene with `SimulationApp({"headless": True, "livestream": 2})`. On 5.1.0
that loads `isaacsim.exp.base` rather than `isaacsim.exp.full.streaming`, so port 49100 never
opens and the client cannot connect at all — verified 2026-09-16. The `livestream` kwarg is
a 4.5-era pattern.

A scene that only drops rigid bodies settles within seconds and then looks frozen. Subscribe
to the app update stream and reset the transforms periodically so a viewer arriving later
still sees motion:

```python
def on_update(event):
    state["frames"] += 1
    if state["frames"] % 420:
        return
    timeline.stop()
    for op, start, velocity, angular in spawns:
        op.Set(start)
        velocity.Set(ZERO)
        angular.Set(ZERO)
    timeline.play()

sub = omni.kit.app.get_app().get_update_event_stream().create_subscription_to_pop(
    on_update, name="redrop"
)
```

### Resolution

The default 1280x720 render looks soft once the client window is larger than that, because
the client upscales. Set the render size on the server and pick the matching resolution in
the client:

```bash
--/app/window/width=1920 --/app/window/height=1080 \
--/app/renderer/resolution/width=1920 --/app/renderer/resolution/height=1080
```

The client's `Resolution` dropdown must be set to the same value; it requests its own size
over the data channel and a mismatch is re-scaled rather than re-rendered.

### Operating the viewer desktop

Three failures cost time on the DCV desktop and none of them are Isaac Sim problems.

**A black client window usually means the desktop locked.** GNOME's screen lock blanks the
console session and the streaming client keeps running behind it. Disable it once per
desktop:

```bash
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
gsettings set org.gnome.desktop.session idle-delay 0
```

**Launching the client over SSM needs the session environment.** `su ubuntu -c ...` inherits
none of it, and the Electron window is created but never mapped (`xwininfo` reports
`IsUnMapped`). Export all four:

```bash
export DISPLAY=:1
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export XAUTHORITY=/run/user/1000/gdm/Xauthority
```

**If every window reports `IsUnMapped`, restart the shell, not the app.** Reinstalling or
resetting the client's config directory does not help; `kill <gnome-shell pid>` lets systemd
respawn it and windows map normally afterwards.

Only one streaming session can exist at a time. A second client instance makes the first one
loop `N of 6 connection attempts have failed` while the server logs
`nvstPushStreamData timeout for eye 0`. Run `pkill -f isaacsim-webrtc` before relaunching.
Connecting before the log line `Isaac Sim Full Streaming App is loaded.` appears yields
`Stream stopped - status=error`.

### What does not work, and why not to retry it

All three were measured on 2026-09-15 against Isaac Sim 4.5.0 and 5.1.0 on `g6.2xlarge`,
with WebRTC Streaming Client 1.0.6 and 1.1.5. Full run in [validation.md](validation.md);
write-up in [docs/osmo-compatibility.md](../../docs/osmo-compatibility.md).

**Port-forwarding the media ports.** Isaac Sim gathers ICE candidates only from the pod's
own interface, so the SDP advertises the pod's VPC address. A forwarder maps those ports
onto the client's `localhost`, an address that appears nowhere in the SDP, so ICE has no
valid candidate pair. Signalling connects and STUN binding requests cross the tunnel, then
ICE goes `checking` -> `disconnected` with zero frames decoded. This is about addresses,
not ports, so forwarding more of them changes nothing.

**Overriding the advertised address.** 5.1.0 accepts
`--/app/livestream/publicEndpointAddress`, and setting it to `127.0.0.1` really does put
`127.0.0.1:47998` in the SDP — verified. ICE still fails, because it only accepts a STUN
response that returns on the exact 5-tuple the request left from, and tunnelling UDP
through a WebSocket relay does not preserve the source address and port.

**Standing up a TURN relay.** Not possible. Isaac Sim exposes no ICE server setting at all:
every `/app/livestream/*` key in the shipped `libcarb.livestream-rtc.plugin.so` was
enumerated (20 keys on 5.1.0, 10 on 4.5.0) and neither set contains `iceServer`,
`stunServer`, or `turnServer`. Isaac Sim never gathers relay candidates, so a TURN server
in the VPC would go unused.

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
