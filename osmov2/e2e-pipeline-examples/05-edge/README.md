# Stage 5 — Edge Deployment

Deploy the fine-tuned GR00T policy to a physical edge device with AWS IoT
Greengrass. This stage is not an OSMO workflow — OSMO runs in the cluster, while
the robot's onboard computer runs Greengrass components. It is the on-robot
counterpart to Stage 4's in-cluster closed-loop eval: same GR00T ZMQ policy
server, same protocol, different host.

Generalized from `e2e-workshop/edge/workshop-components/N1.6/`. The workshop
version hardcoded a CloudFront model tarball and a specific ECR image; here the
model comes from S3 (your Stage 3 checkpoint) and the image is built by
`build-inference-image.sh` into your own ECR.

## Components

| Component | Purpose |
| --- | --- |
| `com.aws.groot.setup` | Sync the fine-tuned model from S3 onto the device (`/opt/groot/models`). Optional TensorRT build. |
| `com.aws.groot.inference` | Run `gr00t.eval.run_gr00t_server` in a container, exposing the ZMQ policy server on port 5555. |

`com.aws.groot.inference` depends on `com.aws.groot.setup` (HARD dependency).

## Scripts

| Script | When | Purpose |
| --- | --- | --- |
| `build-inference-image.sh` | once (rebuild on GR00T version change) | Build the GR00T server Docker image (PyTorch + TRT + Isaac-GR00T) and push to your ECR. The image `com.aws.groot.inference` pulls. |
| `bootstrap-device.sh` | once per device | Install the Greengrass v2 nucleus, provision the IoT thing/group/cert, and grant the device role (TES) S3/ECR/logs permissions. |
| `register-components.sh` | whenever the model or image changes | Register the two recipes as component versions, and optionally create the deployment. |
| `fetch-demo-model.sh` | optional, for a dry run | Push the workshop's pre-trained Pick-Orange demo checkpoint to S3 so you can smoke-check the edge deploy without running Stage 3 first. |
| `run-closeloop-eval.sh` | after a model change | Run the LeIsaac SO-101 closed-loop simulation against the deployed edge policy server to verify the new model. |

The scripts split the single-file workshop installer
(`e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh`) into separate
concerns: image build, one-time device provisioning, and repeatable component
registration/deployment.

## Getting the model onto the device

Stage 3 (`03-vla-finetune`) writes the checkpoint to an OSMO dataset
(`e2e-pipeline-groot-checkpoint`). Export that dataset to S3, then point the
setup component at it:

```bash
# Example: download the OSMO dataset locally, then push to S3
osmo dataset download e2e-pipeline-groot-checkpoint ./ckpt
aws s3 sync ./ckpt s3://<your-bucket>/models/e2e-pipeline-groot-checkpoint
```

Set `modelS3Uri` in `com.aws.groot.setup/recipe.yaml` to that S3 URI.

Haven't run Stage 3 yet? Use the workshop's pre-trained demo checkpoint to
dry-run the edge path first:

```bash
bash fetch-demo-model.sh \
  --s3-uri s3://<your-bucket>/models/groot-demo-pick-orange \
  --region <region>
```

## Deploying

```bash
# 1) Build the GR00T inference image and push to ECR (once).
bash build-inference-image.sh --repo groot-inference --region <region>

# 2) One-time: provision the device (run ON the device, as root).
#    Creates the IoT thing/group/cert and grants the device role S3/ECR access.
sudo bash bootstrap-device.sh \
  --thing-name groot-edge-01 \
  --region <region> \
  --s3-bucket <your-bucket>

# 3) Edit both recipe.yaml files: replace the REPLACE_ME model S3 URI
#    (com.aws.groot.setup) and ECR image (com.aws.groot.inference — use the
#    image URI build-inference-image.sh printed).
#    (Alternatively, skip editing and pass --model-s3-uri / --ecr-image to
#     register-components.sh below — see "Changing the model and redeploying".)

# 4) Register the components and deploy (run anywhere with AWS credentials):
bash register-components.sh \
  --region <region> \
  --deploy --thing-group groot-edge-01-group
```

`register-components.sh` targets `com.aws.groot.inference`; Greengrass resolves
the `com.aws.groot.setup` HARD dependency automatically. To tear a device down,
run `sudo bash bootstrap-device.sh --thing-name groot-edge-01 --uninstall`.

The `e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh` original bundles
all of this (plus a workshop-specific ECR image build) into one file; see it for
the full IAM permission list the provisioning step requires.

## Changing the model and redeploying

This is the point of Stage 5 for the pipeline: after a new Stage 3 run, push the
new checkpoint to S3 and roll it out to the device without touching recipes or
bumping component versions. Pass the new location as a deployment-time override:

```bash
# New checkpoint exported to a NEW S3 prefix, then:
bash register-components.sh \
  --region <region> \
  --deploy --thing-group groot-edge-01-group \
  --model-s3-uri s3://<your-bucket>/models/<new-prefix>
```

`--model-s3-uri` is injected as a Greengrass `configurationUpdate.merge` on
`com.aws.groot.setup`, so the setup component re-runs and the inference component
(HARD dependency) restarts to load the new model. Related overrides:

| Override | Applies to | Effect |
| --- | --- | --- |
| `--model-s3-uri <URI>` | `com.aws.groot.setup` `modelS3Uri` | Device pulls this model on the next deployment. |
| `--model-name <NAME>` | setup `modelName` + inference `modelPath` | Stage the model under a different on-device dir (kept consistent for both components). |
| `--ecr-image <IMAGE>` | `com.aws.groot.inference` `ecrImage` | Roll a new server image (e.g. after `build-inference-image.sh`). |

Two behaviors make this reliable:

- **The setup component always mirror-syncs** (`aws s3 sync --delete`). A changed
  `modelS3Uri` (or a new checkpoint at the same URI) fully **replaces** the model
  already on the device; unchanged files are not re-downloaded, so redeploys stay
  cheap. It refuses to sync from an empty/placeholder URI so it never wipes a
  good model directory. (The earlier "skip if a model already exists" logic meant
  a changed `modelS3Uri` was silently ignored — that is fixed.)
- **Overrides don't need a version bump.** Editing a recipe's `modelS3Uri`
  *without* bumping `ComponentVersion` would be silently ignored (the version
  already exists), so use the override flags for model swaps. Bump
  `ComponentVersion` only when you change recipe/script *logic*.

## Verify a changed model in simulation

After you redeploy a new model, drive it in LeIsaac's SO-101 pick-orange
closed-loop simulation to check the new policy — the sim connects to the edge
ZMQ policy server the same way Stage 4 does:

```bash
# 1) deploy the new model (edge server reloads it on :5555)
bash register-components.sh --region <region> --deploy \
  --thing-group groot-edge-01-group \
  --model-s3-uri s3://<your-bucket>/models/<new-prefix>

# 2) run the closed-loop sim against the edge server (on a GPU host)
bash run-closeloop-eval.sh --eval-rounds 5
```

`run-closeloop-eval.sh` runs LeIsaac's `policy_inference.py` as a client against
`--policy-host/--policy-port` (default `localhost:5555`, since the edge server
uses host networking). It reuses the `isaac-lab` container image and bakes in the
fixes needed for headless RTX rollout:

- `NVIDIA_DRIVER_CAPABILITIES=all` — RTX camera rendering needs the Vulkan
  *graphics* capability (`--gpus all` alone gives only compute/utility, so camera
  render fails with `vkGetMemoryFdKHR` / shared-handle errors).
- numpy pinned `<2` in the client packages — Isaac Sim ships numpy 1.x; a numpy
  2.x on `PYTHONPATH` crashes Kit at startup with an ABI segfault.
- LeIsaac pinned to the eval-capable commit + the N1.6 dynamic-language-key and
  headless-keyboard / `wait_for_textures` patches.
- torch/CUDA pruned from the client dir (use Isaac Sim's bundled stack),
  `PYTHONUNBUFFERED=1`, and a dedicated shader cache.

Requirements: an NVIDIA GPU + NVIDIA Container Toolkit + Docker on the host, and
the edge policy server reachable (default same host, `:5555`). The GR00T server
image commit and the model's `embodimentTag` must match the task (the SO-101
pick-orange task expects a `NEW_EMBODIMENT` fine-tune, not the base GR1 model).

> The intended/validated home for closed-loop eval is **Stage 4 (04-closeloop)
> via OSMO**, which provisions a matching environment. `run-closeloop-eval.sh`
> lets you smoke-test the *deployed edge model* on the edge host, but running the
> full Isaac Sim scene on an arbitrary box can still hit Isaac Sim / scene-asset
> environment issues; if it stalls during scene creation, use Stage 4 on OSMO.




Once running, the device exposes the same ZMQ REQ/REP interface used in Stage 4.
A robot control loop sends observations (camera frames + proprioception +
instruction) and receives a horizon of future joint commands. Use the GR00T
repo's client helpers (`gr00t/eval`) or the `batch-zmq` ping client from the
e2e workshop to verify the server responds.

## Verifying the deployed server

Confirm the on-device server actually loaded the model and serves inference by
driving it with GR00T's **own** client (`gr00t.policy.server_client.PolicyClient`).
Run it *inside the running inference container* so the ZMQ msgpack serialization
matches the server exactly (a client on the host with a different `msgpack`
build can fail to deserialize — see the note below):

```bash
CID=$(sudo docker ps -q --filter name=groot-edge-inference | head -1)
sudo docker exec "$CID" python - <<'PY'
import numpy as np
from gr00t.policy.server_client import PolicyClient

c = PolicyClient(host="localhost", port=5555)
print("ping:", c.ping())
print("modalities:", list(c.get_modality_config().keys()))

# Nested observation ({video,state,language} dicts) — NOT flattened
# ("video.front"). Keys/shapes come from get_modality_config() (SO-101:
# front/wrist cameras, single_arm[5]+gripper[1] state); images are (B,T,H,W,3).
obs = {
    "video":    {"front": np.zeros((1, 1, 480, 640, 3), np.uint8),
                 "wrist": np.zeros((1, 1, 480, 640, 3), np.uint8)},
    "state":    {"single_arm": np.zeros((1, 1, 5), np.float32),
                 "gripper":    np.zeros((1, 1, 1), np.float32)},
    "language": {"annotation.human.task_description":
                 [["pick up the orange and place it on the plate"]]},
}
action, info = c.get_action(obs)
for k, v in action.items():
    print("action", k, v.shape)   # single_arm (1, 16, 5) ; gripper (1, 16, 1)
PY
```

A healthy server prints `ping: True`, the model's modality config
(`video/state/action/language`), and a 16-step action horizon
(`single_arm (1, 16, 5)`, `gripper (1, 16, 1)`). This verifies
deployment + model load + inference end to end, without needing the full
Isaac Sim closed-loop.

> **Serialization note.** Server and client must share the same `msgpack`
> encoding. The GR00T ZMQ protocol packs numpy arrays with `msgpack` +
> `use_bin_type=True` (modern `msgpack>=1.0`); an old `msgpack-python` 0.5.6
> on the client packs them as raw strings, so the server fails with
> `'utf-8' codec can't decode byte 0x93` (the `.npy` magic). Running the check
> inside the inference container avoids this. If you drive the server from
> another environment (e.g. the Stage-4-style LeIsaac client), make sure its
> GR00T server commit and `msgpack` build match this image.

## Notes

- The inference component pulls its image from your **private ECR**. It logs the
  docker daemon in with the device (TES) role — which `bootstrap-device.sh`
  grants ECR pull permissions — and `docker pull`s before `docker run`, so a
  newly pushed tag is picked up on redeploy. Build/push the image with
  `build-inference-image.sh` to an ECR repo in an account/region the device role
  can reach (a non-ECR image URI skips the login).
- The workshop's TensorRT path (DiT action-head acceleration) is model- and
  script-specific; `buildTrt` defaults to `false` so this component runs GR00T
  in PyTorch mode. Bring your own `export_onnx` / `build_tensorrt_engine`
  scripts if you want TRT.
- The recipes target `architecture: amd64` (x86_64 GPU host, e.g. a G6e/L40S
  EC2). An aarch64 device (Jetson/Thor) would not match this platform.
- The device needs an NVIDIA GPU, the NVIDIA container toolkit, and network
  reachability from the robot control process on port 5555.
