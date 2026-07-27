# Isaac Sim Livestream Validation

This file records validation for [workflow.yaml](workflow.yaml) (Isaac Sim
4.5.0) and [workflow-5.1.yaml](workflow-5.1.yaml) (Isaac Sim 5.1.0).

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
  TCP `49100`, media on the `47995-48012` / `49000-49007` range. The
  README instructs both a TCP and a UDP `osmo workflow port-forward`, which is
  required because WebRTC media is UDP.
- `ACCEPT_EULA=Y` is set in `entry.sh`, which the Isaac Sim container requires
  for non-interactive start.

### Still to verify at runtime

- [ ] Confirm the sim reaches `Running` and the WebRTC client connects through
      the two `osmo workflow port-forward` sessions (TCP + UDP).
- [ ] Confirm idle GPU-memory headroom: README states ~12GB (4.5.0) / ~18GB
      (5.1.0) at idle, which fits the 24GB floor of the smallest G7e; large
      scenes may need a bigger instance.
- [ ] `runheadless.sh` on the 5.1.0 image: the container docs consolidated on
      `runheadless.sh` (WebRTC), but 5.x wrapper-script naming has drifted
      historically. If the 5.1.0 image does not expose `runheadless.sh`, switch
      to the image's shipped headless-webrtc entrypoint.

### Notes

- This workflow is interactive (submit-and-stream), not submit-and-forget:
  there is no output dataset. It holds a G7e node until the 2h `exec_timeout`
  or manual `osmo workflow cancel`.
- Newer Isaac Sim containers honour `ISAACSIM_HOST` / `ISAACSIM_SIGNAL_PORT` /
  `ISAACSIM_STREAM_PORT` env vars to override streaming host/ports; not needed
  for the default OSMO port-forward path but useful if ports collide.
