# HY-World 2.0 WorldMirror Reconstruction

HY-World 2.0 WorldMirror reconstruction workflow using the upstream `Dining_Table` sample and pinned source/model refs.

Files:

- [workflow.yaml](workflow.yaml): OSMO workflow definition.
- [validation.md](validation.md): completed validation run and visual artifacts.
- [validation/](validation/): retained input/output previews and run manifests.

Run the validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/hyworld2-worldmirror-recon/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

The default run keeps `gaussians.ply` and `points.ply` in the OSMO dataset, but only lightweight previews are committed to this repository.
