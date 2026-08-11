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
