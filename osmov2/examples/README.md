# Examples

Each directory is a self-contained OSMO or AWS platform example.
Single-workflow OSMO examples use `workflow.yaml`; multistage examples keep
ordered workflow YAMLs under `workflows/`. Example-specific run notes and
validation artifacts stay next to the example.

| Example | Purpose | Validation |
| --- | --- | --- |
| [osmo-smoke](osmo-smoke/README.md) | CPU-only OSMO smoke workflow. | Validation in [validation.md](osmo-smoke/validation.md). |
| [gpu-smoke](gpu-smoke/README.md) | OSMO GPU smoke workflow that runs `nvidia-smi`. | Validation in [validation.md](gpu-smoke/validation.md). |
| [g7e-efa-nccl-benchmark](g7e-efa-nccl-benchmark/README.md) | Kubernetes-native 2-node G7e EFA NCCL all-reduce benchmark. | Validation in [validation.md](g7e-efa-nccl-benchmark/validation.md). |
| [g7e-efa-ddp-benchmark](g7e-efa-ddp-benchmark/README.md) | Kubernetes-native 2-node G7e PyTorch DDP training benchmark comparing EFA against NCCL socket networking. | Validation in [validation.md](g7e-efa-ddp-benchmark/validation.md). |
| [parallel-eval](parallel-eval/README.md) | OSMO `groups` fan-out/fan-in reference. | Validation in [validation.md](parallel-eval/validation.md). |
| [sequential-policy](sequential-policy/README.md) | CPU dataset inspect, GPU policy checkpoint task, CPU package step. | Validation in [validation.md](sequential-policy/validation.md). |
| [isaaclab-rsl-rl-video](isaaclab-rsl-rl-video/README.md) | Isaac Lab RSL-RL training with videos and TensorBoard plots. | Validation in [validation.md](isaaclab-rsl-rl-video/validation.md). |
| [isaacsim-livestream](isaacsim-livestream/README.md) | Interactive Isaac Sim headless + WebRTC livestream workflow, streamed over an OSMO workflow port-forward. | Validation in [validation.md](isaacsim-livestream/validation.md). |
| [gr00t-finetune](gr00t-finetune/README.md) | PASK-aligned GR00T fine-tune workflow. | E2E and 10k-step validation in [validation.md](gr00t-finetune/validation.md). |
| [openpi-libero-lora](openpi-libero-lora/README.md) | PASK-aligned OpenPI LIBERO LoRA workflow. | E2E and 30k-step validation in [validation.md](openpi-libero-lora/validation.md). |
| [cosmos-reason2-nim](cosmos-reason2-nim/README.md) | World model VLM workflow using Cosmos Reason2 NIM and NVIDIA OSMO's NIM client/server pattern. | Validation in [validation.md](cosmos-reason2-nim/validation.md). |
| [hyworld2-worldmirror-recon](hyworld2-worldmirror-recon/README.md) | World model reconstruction workflow using HY-World 2.0 WorldMirror on the upstream Dining Table sample. | Validation in [validation.md](hyworld2-worldmirror-recon/validation.md). |
| [lyra2-dmd-single](lyra2-dmd-single/README.md) | World model generation workflow using Lyra-2.0 DMD and Gaussian-scene trajectory rendering. | Validation in [validation.md](lyra2-dmd-single/validation.md). |
| [nut-pouring-pipeline](nut-pouring-pipeline/README.md) | Multistage upstream OSMO nut pouring pipeline with MimicGen, Cosmos Transfer, LeRobot conversion, and GR00T fine-tuning. | Validation in [validation.md](nut-pouring-pipeline/validation.md). |

Submit single-workflow examples directly with
`osmo workflow submit examples/<name>/workflow.yaml`, or use
`scripts/smoke-test.sh` when you want the repo wrapper to handle OSMO login,
credentials, submission, logs, and timeout handling. For multistage examples,
follow the example README or submit the numbered workflow files in order.

GPU workflows need visible G7e capacity before OSMO resource validation. Use `scripts/prewarm-gpu-node.sh` before submission and `scripts/wait-gpu-node-cleanup.sh` after completion.
