# Isaac Sim Livestream Validation

This file records validation for [workflow.yaml](workflow.yaml) (Isaac Sim
4.5.0) and [workflow-5.1.yaml](workflow-5.1.yaml) (Isaac Sim 5.1.0), plus the
`g6`/L4 fallback variants actually used for the runtime runs below.

## 2026-07-27 Source-level audit (pre-runtime)

Status: Passed (static). Full GPU runtime livestream not yet run — pending G7e
On-Demand capacity.

Method: verified the container entrypoint, the livestream flag, the working
directory, and the port ranges against the NVIDIA Isaac Sim container
documentation and against the version pins used by
[`e2e-workshop`](../../../e2e-workshop/). No GPU node was consumed.

### Verified OK (no change needed)

- Image pins match `e2e-workshop`: `nvcr.io/nvidia/isaac-sim:4.5.0` (stable)
  and `nvcr.io/nvidia/isaac-sim:5.1.0` (latest) are exactly the tags in
  `e2e-workshop/infra/isaaclab/lib/config/version-profiles.ts`.
- Entrypoint: the Isaac Sim container ships `runheadless.sh` at working
  directory `/isaac-sim`, so `cd /isaac-sim && ./runheadless.sh` is correct for
  both tags (confirmed against the NVIDIA container install docs).
- Livestream flag: `--/app/livestream/enabled=true` is the documented app
  setting to enable the WebRTC livestream server.
- Port ranges in the README match the WebRTC streaming defaults: signalling on
  TCP `49100`, media on the `47995-48012` / `49000-49007` range.

  The README also instructed both a TCP and a UDP `osmo workflow port-forward`,
  on the reasoning that "WebRTC media is UDP, so forward UDP too". That step does
  not follow: forwarding the UDP ports is necessary but not sufficient, because
  it does nothing about the addresses ICE negotiates over them. Only a live
  client attempt exposes that, which is what the runtime run below did.
- `ACCEPT_EULA=Y` is set in `entry.sh`, which the Isaac Sim container requires
  for non-interactive start.

### Still to verify at runtime

- [x] Confirm the sim reaches `Running` and the WebRTC client connects through
      the two `osmo workflow port-forward` sessions (TCP + UDP).
      Closed 2026-09-15: the server side passes, the client path cannot work at
      all. See the runtime section below.
- [x] Confirm idle GPU-memory headroom: README states ~12GB (4.5.0) / ~18GB
      (5.1.0) at idle, which fits the 24GB floor of the smallest G7e; large
      scenes may need a bigger instance.
      Closed 2026-09-15: both figures were wrong by an order of magnitude.
      Measured on `NVIDIA L4` (23034MiB): 577MiB idle on 4.5.0, 2032MiB idle on
      5.1.0. Both versions fit L4 with room for a scene.
- [x] `runheadless.sh` on the 5.1.0 image: the container docs consolidated on
      `runheadless.sh` (WebRTC), but 5.x wrapper-script naming has drifted
      historically. If the 5.1.0 image does not expose `runheadless.sh`, switch
      to the image's shipped headless-webrtc entrypoint.
      Closed 2026-09-15: the 5.1.0 image ships `runheadless.sh` and it starts
      the WebRTC streaming server.

## 2026-09-15 GPU runtime validation (g6 / L4)

Status: server path **passed**, client path **cannot pass over port-forward**.

Run on `g6.2xlarge` (platform `g6-l4`) in the `us-east-1` reference cluster with
[workflow-g6.yaml](workflow-g6.yaml), after every g7e and g6e size was
unavailable in both reachable AZs. Client was macOS with the Isaac Sim WebRTC
Streaming Client.

### Server side — passed

- `Isaac Sim Full Streaming Version: 4.5.0`, then `Streaming server started.`,
  then `Isaac Sim Full Streaming App is loaded.`
- Time to fully loaded: ~8m20s to ~8m36s, consistent across three runs.
- Idle GPU memory: 577MiB / 23034MiB on `NVIDIA L4`. The README's ~12GB figure
  was wrong by more than an order of magnitude.
- Listeners while idle: TCP `49100` only, no UDP. Media ports open after
  signalling, so an empty UDP list before a client connects is expected.
- TCP port-forward to `49100` is transparent: the forwarded response matches an
  in-container request.
- Benign startup warnings: `ROS2 Bridge startup failed` (unset
  `AMENT_PREFIX_PATH`), the iray ECC performance advisory, `carb.tasking is
  likely stuck`, and `TLAS limit` messages.

### Client side — blocked, and not by a bug

Measured with the sim fully loaded and both TCP and UDP tunnels up (the UDP leg
hand-rolled, since CLI 6.3.1 `--udp` is broken independently):

- Signalling over TCP `49100`: connected.
- TCP ICE candidates offered: 0 — a TCP-only media path is not available.
- UDP tunnel throughput: 100+ requests, 400+ responses forwarded, so the tunnel
  itself carried traffic.
- Payloads observed: STUN binding only (96B request, 64B response). No media.
- ICE state: `checking` -> `disconnected`.
- `total_bps=0`, `framesDecoded=0`; client reported an address-unreachable error.

Cause: Isaac Sim gathers host ICE candidates from the pod's own interface only,
so the SDP advertises the pod's VPC address. A forwarder maps the ports onto the
client's `localhost`, which appears nowhere in the SDP, so ICE has no valid pair
to check. Resolving this inside a forwarder would require SDP/ICE rewriting —
an application-layer gateway, which the OSMO relay is not.

Fixing the CLI `--udp` defect does not fix this. The two are independent.

### Resolution

The client must reach the pod IP directly. Either make the cluster VPC routable
from the client (VPN / subnet router), or run the client on a GUI desktop inside
the VPC. Either way, allow the client source to reach TCP `49100` and UDP
`47995-48012` / `49000-49007` on the node security group. On 5.1.0,
`--/app/livestream/fixedHostPort=47998` narrows the UDP side to that single port.

TURN is not available. Isaac Sim exposes no ICE server setting: every
`/app/livestream/*` key in the shipped `libcarb.livestream-rtc.plugin.so` was
enumerated — 20 keys on 5.1.0, 10 on 4.5.0 — and neither set contains
`iceServer`, `stunServer`, or `turnServer`. A TURN server in the VPC would not
help because Isaac Sim never gathers relay candidates.

## 2026-09-15 GPU runtime validation (5.1.0 / publicEndpointAddress)

Status: address pinning **works**, client path still **cannot pass over
port-forward**.

Run on the same `g6.2xlarge` node with
[workflow-g6-5.1-pubep.yaml](workflow-g6-5.1-pubep.yaml), which sets
`--/app/livestream/publicEndpointAddress=127.0.0.1` and
`--/app/livestream/fixedHostPort=47998`. Those two settings exist on 5.1.0 and
are absent from 4.5.0, so this run tests whether overriding the advertised
address is enough to rescue the port-forward path.

### What changed versus 4.5.0

- Both settings took effect. The pod listened on TCP `49100` and UDP `47998`
  while idle, and the SDP advertised `127.0.0.1:47998` instead of the pod IP.
- Streaming server up in 63s, versus ~8m20s for 4.5.0 on the same node.
- Idle GPU memory: 2032MiB / 23034MiB on `NVIDIA L4`. 5.1.0 fits L4 comfortably,
  so the earlier "L4 is too small for 5.1" reasoning does not hold.
- Livestream setting keys present in the image: 20 on 5.1.0, 10 on 4.5.0.
  Neither set contains any ICE/STUN/TURN server key.

### Still blocked

- ICE never completed. The server logged repeated `NVST_CCE_DISCONNECTED` with
  `m_connectionCount` underflowing past zero.
- Reproduced with WebRTC Streaming Client 1.0.6 and 1.1.5.

Cause: ICE only accepts a STUN response that returns on the exact 5-tuple the
request left from, and wrapping UDP inside a WebSocket relay does not preserve
the source address and port. Pinning the advertised address is necessary but not
sufficient. Four combinations — 4.5.0 and 5.1.0 against clients 1.0.6 and
1.1.5 — fail at the same point.

`publicEndpointAddress` is still worth setting when the client reaches the pod
directly, since the pod IP is then routable and `fixedHostPort` reduces the
security-group opening to one UDP port.

### Notes

- This workflow is interactive (submit-and-stream), not submit-and-forget:
  there is no output dataset. It holds a G7e node until the 2h `exec_timeout`
  or manual `osmo workflow cancel`.
- Newer Isaac Sim containers honour `ISAACSIM_HOST` / `ISAACSIM_SIGNAL_PORT` /
  `ISAACSIM_STREAM_PORT` env vars to override streaming host/ports; not needed
  for the default OSMO port-forward path but useful if ports collide.
