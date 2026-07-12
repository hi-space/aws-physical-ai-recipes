# Stage 5 — Edge Deployment

Deploy the fine-tuned GR00T policy to a physical edge device with AWS IoT
Greengrass. This stage is not an OSMO workflow — OSMO runs in the cluster, while
the robot's onboard computer runs Greengrass components. It is the on-robot
counterpart to Stage 4's in-cluster closed-loop eval: same GR00T ZMQ policy
server, same protocol, different host.

Generalized from `e2e-workshop/edge/workshop-components/N1.6/`. The workshop
version hardcoded a CloudFront model tarball and a specific ECR image; these
components take the model from S3 and the image from your own ECR.

## Components

| Component | Purpose |
| --- | --- |
| `com.aws.groot.setup` | Sync the fine-tuned model from S3 onto the device (`/opt/groot/models`). Optional TensorRT build. |
| `com.aws.groot.inference` | Run `gr00t.eval.run_gr00t_server` in a container, exposing the ZMQ policy server on port 5555. |

`com.aws.groot.inference` depends on `com.aws.groot.setup` (HARD dependency).

## Getting the model onto the device

Stage 3 (`03-training`) writes the checkpoint to an OSMO dataset
(`e2e-pipeline-groot-checkpoint`). Export that dataset to S3, then point the
setup component at it:

```bash
# Example: download the OSMO dataset locally, then push to S3
osmo dataset download e2e-pipeline-groot-checkpoint ./ckpt
aws s3 sync ./ckpt s3://<your-bucket>/models/e2e-pipeline-groot-checkpoint
```

Set `modelS3Uri` in `com.aws.groot.setup/recipe.yaml` to that S3 URI.

## Deploying

These are standard Greengrass v2 component recipes. Publish them and create a
deployment targeting your device/thing group:

```bash
# Prereq: Greengrass v2 nucleus installed and provisioned on the device
# (see e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh for a full
#  provisioning example, including the IAM permissions the device role needs).

# 1) Edit both recipe.yaml files: replace REPLACE_ME S3 URI and ECR image.
# 2) Create the components (per component):
aws greengrassv2 create-component-version \
  --inline-recipe fileb://com.aws.groot.setup/recipe.yaml
aws greengrassv2 create-component-version \
  --inline-recipe fileb://com.aws.groot.inference/recipe.yaml

# 3) Deploy to your thing group:
aws greengrassv2 create-deployment \
  --target-arn "arn:aws:iot:<region>:<account>:thinggroup/<group>" \
  --components '{
    "com.aws.groot.inference": {"componentVersion": "1.0.0"}
  }'
```

Greengrass resolves the `com.aws.groot.setup` dependency automatically.

## Talking to the policy server

Once running, the device exposes the same ZMQ REQ/REP interface used in Stage 4.
A robot control loop sends observations (camera frames + proprioception +
instruction) and receives a horizon of future joint commands. Use the GR00T
repo's client helpers (`gr00t/eval`) or the `batch-zmq` ping client from the
e2e workshop to verify the server responds.

## Notes

- The workshop's TensorRT path (DiT action-head acceleration) is model- and
  script-specific; `buildTrt` defaults to `false` so this component runs GR00T
  in PyTorch mode. Bring your own `export_onnx` / `build_tensorrt_engine`
  scripts if you want TRT.
- The device needs an NVIDIA GPU, the NVIDIA container toolkit, and network
  reachability from the robot control process on port 5555.
