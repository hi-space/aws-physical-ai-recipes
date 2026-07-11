# Isaac Sim Livestream Validation

This file records validation for [workflow.yaml](workflow.yaml) /
[workflow-g6.yaml](workflow-g6.yaml).

## 2026-07-11 Isaac Sim Headless + WebRTC Livestream Boot (G6/L4)

Status: Passed (server-side); streaming-client connect step not run in this
environment (see Notes).

Validated against a live OSMO **6.3.1** cluster. G7e (RTX PRO 6000) was out of
capacity in `ap-northeast-2a`/`2b`, so this run used the G6 (NVIDIA L4) fallback
platform (`g6-l4`) via [workflow-g6.yaml](workflow-g6.yaml).

Commands:

```bash
GPU_PREWARM_INSTANCE_TYPE=g6.2xlarge KARPENTER_NODEPOOL_NAME=aws-osmo-g6 \
  scripts/prewarm-gpu-node.sh
osmo profile set pool default
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

Observed result:

- Workflow: `aws-osmo-isaacsim-livestream-1` (submit output in
  [validation/submit.txt](validation/submit.txt)).
- Task pod `78e3e37003b84175-777cb45d20dc4016` reached **2/2 Running** on a
  `g6.2xlarge` node (1 × NVIDIA L4). Container images
  ([validation/task-pod-images.txt](validation/task-pod-images.txt)):
  - `nvcr.io/nvidia/osmo/init-container:6.3.1` (OSMO init)
  - `nvcr.io/nvidia/isaac-sim:5.1.0` (~7.6 GB, pulled in 2m35s)
  - `nvcr.io/nvidia/osmo/client:6.3.1` (osmo-ctrl sidecar)
- Isaac Sim booted headless with livestreaming enabled
  ([validation/isaac-sim-boot.txt](validation/isaac-sim-boot.txt)):
  - `omni.kit.livestream.core-7.5.0 startup`
  - `omni.kit.livestream.webrtc-7.0.0 startup`
  - `Isaac Sim Full Streaming Version: 5.1.0-rc.19`
  - `isaacsim.exp.full.streaming-5.1.0 startup`
  - `app ready`
  - `No windowing` warnings are expected for headless streaming (no local
    display; the frame is served over WebRTC).

Notes:

- This confirms the workflow runs end-to-end and the Isaac Sim WebRTC livestream
  server comes up ready to accept a client. The final step — connecting the
  desktop **Isaac Sim Streaming Client** over the TCP+UDP `osmo workflow
  port-forward` and capturing the viewport — was **not** performed here: the
  validation host is headless and has no GUI streaming client. Run that step
  from a workstation with the client installed (see [README.md](README.md)) and
  add a `validation/streaming-client-connected.png` screenshot to complete the
  visual confirmation.
- Prefer G7e (`platform: g7e-rtx-pro-6000`, [workflow.yaml](workflow.yaml)) when
  capacity is available; use the G6/L4 fallback only when G7e is unfulfillable
  in-region.
