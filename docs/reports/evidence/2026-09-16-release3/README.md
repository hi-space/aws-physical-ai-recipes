# Release 3 evidence

These artifacts record bounded, owned tests in account `913524902871`, `us-east-1`, project `workshop`, default EKS backend. The feature inventory and release report distinguish measured success from unsupported or untested capabilities.

- `isaaclab-proof.json`: actual CUDA training, checkpoint checksums, pinned replay and decoded nonblank 1280×720 video (398 sampled colors).
- `model-pipeline-proof.json`: actual MuJoCo training, two-episode evaluation, registered model/report/video and **REVIEW, approved=false**. The separate 20-episode attempt exceeded its rendering budget and was cancelled.
- Task JSON files are projected durable records without credentials. The distributed plan records intended placement; `distributed.log` records the E2E that additionally verified actual Pod node names, live zone labels and trained output bytes.
- `cpu-hydration.log` contains one initial hosted-login failure before producer creation and one successful hydration case; `cpu-producer.log` is the passing standalone producer retry.
- `dcv-host-audit.json` records the healthy existing console and current application processes predating the authorized service-only activation. `consoleReadyCode` is creation capacity, not existing-console health. A complete before/after PID comparison was not emitted by the first probe, so no such claim is made.
- No real webhook recipient, robot motion, additional backend, or successful SageMaker GR00T training is represented by these artifacts.

Original `/tmp` logs and test sources remain available in the shared workspace. No commit or merge has been made by the coordinator.
