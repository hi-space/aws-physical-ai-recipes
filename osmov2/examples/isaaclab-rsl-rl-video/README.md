# Isaac Lab RSL-RL Video

Isaac Lab RSL-RL workflow for `Isaac-Reach-Franka-v0`. It trains for a bounded number of iterations and exports checkpoint, scalar summaries, and before/after videos.

| File | Isaac Lab / Sim | Platform | Notes |
| --- | --- | --- | --- |
| `workflow.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G7e | stable, validated |
| `workflow-g6.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G6 L4 | G6 fallback |
| `workflow-g6-video.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G6 L4 | video-only variant |
| `workflow-5.1.yaml` | 2.3.0 (Isaac Sim 5.1.0) | G7e | latest |

Run it through the repo wrapper:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/isaaclab-rsl-rl-video/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

Validation:

- [validation.md](validation.md)
- Fresh run: `aws-isaaclab-rsl-rl-video-9`
- Observed runtime: `976s` after G7e prewarm
- Expected completion time: `30-35 min` including G7e provisioning and cleanup
- Artifact dataset: `aws-osmo/aws-isaaclab-rsl-rl-video-artifacts:4`
- Artifacts: `before-training.mp4`, `after-training.mp4`, TensorBoard scalar CSVs, `metrics-summary.json`, and `model_199.pt`

Result:

- [before/after preview](validation/result/videos/before-after-preview.png)
- [before/after comparison](validation/result/videos/before-after-comparison.mp4)
- [before training video](validation/result/videos/before-training.mp4)
- [after training video](validation/result/videos/after-training.mp4)
- [metrics summary](validation/result/metrics-summary.json)

The example uses `Isaac-Reach-Franka-v0` because it ships in the pinned Isaac Lab image and produces visible artifacts quickly.
