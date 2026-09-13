# GR00T Fine-tuning Infrastructure

A CDK TypeScript project that deploys, in a single shot, the AWS infrastructure needed to fine-tune the NVIDIA GR00T VLA model.

> 한국어 문서: [README.ko.md](README.ko.md)

## Overview

This project takes the VPC created by the parent [`infra/isaaclab/`](../isaaclab/) stack as-is, and layers on top of it the resources required for GR00T training and inference. A SageMaker training job exports its decompressed checkpoint to an S3 artifact bucket, and the IsaacLab DCV instance mounts that bucket as an Amazon S3 Files file system at `/mnt/s3/groot` (`sudo s3files-mount GrootFinetune-<ACCOUNT_ID> /mnt/s3/groot`) to validate it in simulation with no download (`aws s3 sync` still works as a fallback). If the parent stack was deployed with `-c enableFsx=true`, a DRA (Data Repository Association) is attached to that FSx so the checkpoint automatically shows up under `/fsx/groot/...`.

This is a **single stack**, built on the assumption of one account per person.

| Stack | Resources |
|------|--------|
| **GrootFinetune-`<ACCOUNT_ID>`** | 2 ECR repositories (GR00T runtime `groot-runtime` + SageMaker training `groot-sm-training`), 2 CodeBuild projects that build the container images (`groot-runtime-build`, `groot-sm-training-build`), a SageMaker Studio Domain + UserProfile, an S3 artifact bucket (`groot-sm-artifacts-<ACCOUNT_ID>-<REGION>`), an S3 Files file system + mount target over that bucket (NFS 2049 SG, service role `GR00TS3FilesRole-*`), an optional shared FSx DRA, IAM roles, and an MLflow tracking server |

## Prerequisites

- The parent IsaacLab stack must already be deployed ([`../isaaclab/`](../isaaclab/))
- Node.js 18+, AWS CDK CLI
- CDK Bootstrap completed in the deployment region

## Getting Started

```bash
npm install
npm run deploy
```

Once the stack is deployed, the GR00T runtime container image (about 27GB) is automatically built by CodeBuild (`groot-runtime-build`). This takes about 30 minutes. Only the build project is registered for the SageMaker training container; it is triggered separately via `../../groot/training/scripts/trigger_build.py`.

After the deployment finishes, update the `config.yaml` used by the GR00T training/inference code (`../../groot/`):

```bash
npx ts-node bin/update-config.ts --region us-east-1
```

From then on, you can start training from `../../groot/` with a command like `python training/scripts/run_training.py ...`.

## Configuration

Pass values via `cdk deploy -c key=value` or through `cdk.context.json`.

| Key | Default | Description |
|----|--------|------|
| `region` | `us-east-1` | Deployment region |
| `grootVersion` | `n1.6` | `n1.6` or `n1.7`. The GR00T version CodeBuild builds |
| `useStableGroot` | `true` | Use a verified release commit (`false` uses the latest) |
| `bucketName` | `groot-sm-artifacts-<ACCOUNT_ID>` | SageMaker artifact bucket name |
| `mlflowSize` | `Small` | MLflow tracking server size |
| `enableS3Files` | `true` | Expose the artifacts bucket as an S3 Files file system with a mount target in the parent private subnet. Emits the `S3FilesFileSystemId` and `S3FilesMountCommand` Outputs. `false` skips it (checkpoints via `aws s3 sync`) |
| `vpcId` / `privateSubnetId` / `availabilityZone` / `vpcCidr` / `fsxFileSystemId` | (auto-discovered) | Manual overrides that skip parent stack auto-discovery (`vpcCidr` is the NFS inbound source for the S3 Files mount target SG) |

`bin/groot-finetune-app.ts` automatically pulls the VPC ID, private subnet, VPC CIDR, and (if present) the shared FSx ID from the outputs of the `IsaacLab-<Profile>-<ACCOUNT_ID>` stack. The result is cached in `cdk.context.json` and reused on the next deployment — if you remove the parent stack's FSx and redeploy, you must clear `fsxFileSystemId` from `cdk.context.json` so the DRA is not created. Deployment fails if there is no parent IsaacLab stack, so be sure to deploy the IsaacLab stack first.

## Project Structure

```
infra/groot/
├── bin/
│   ├── groot-finetune-app.ts      CDK App entry point
│   ├── resolve-parent-stack.ts    Auto-discovers the parent IsaacLab stack
│   └── update-config.ts           Syncs CFN outputs into ../../groot/config.yaml
├── lib/
│   ├── groot-finetune-stack.ts    Unified stack (ECR/CodeBuild/Studio/S3/MLflow)
│   └── constructs/
├── assets/                          Training container buildspec, fine-tune execution scripts, sample modality config
├── cdk.json
└── package.json
```

## Cleanup

```bash
npm run destroy
```

ECR images and S3 objects may need to be emptied before deleting the stack (resources with auto-delete configured are cleaned up automatically).

## See Also

- [`docs/deployment-guide.md`](./docs/deployment-guide.md) — Deployment procedure and troubleshooting
- [`../../groot/`](../../groot/) — Training/inference code that runs on top of this infrastructure
- [`../isaaclab/`](../isaaclab/) — The parent IsaacLab infrastructure
