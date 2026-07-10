# Cosmos Reason2 NIM

Cosmos Reason2 VLM workflow using NVIDIA OSMO's NIM client/server pattern with `nvidia/cosmos-reason2-2b`.

Files:

- [workflow.yaml](workflow.yaml): OSMO workflow definition.
- [validation.md](validation.md): completed validation run, input preview, prompt, and model output.
- [validation/](validation/): retained request, response, video preview, and manifest artifacts.

Run the local NIM validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/cosmos-reason2-nim/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
kubectl -n osmo-workflows delete pod aws-osmo-gpu-prewarm --ignore-not-found
scripts/wait-gpu-node-cleanup.sh
```

Use `g7e.4xlarge` or larger for the default local server resources. The server requests `cpu: 12`, `memory: 96Gi`, `storage: 256Gi`, and `gpu: 1`.

To call a hosted NIM instead of launching the server task, create `ngc-api-key` and submit with:

```bash
osmo workflow submit examples/cosmos-reason2-nim/workflow.yaml \
  --pool default \
  --set external_nim_server_url=https://integrate.api.nvidia.com
```

The workflow uploads the request JSON, response JSON, answer text, and run manifest. The validation prompt asks Cosmos Reason2 to approve or reject the input video for robotics dataset inclusion and include a short rationale.
