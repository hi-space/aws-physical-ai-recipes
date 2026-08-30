# GR00T Fine-tuning Infrastructure

NVIDIA GR00T VLA 모델을 AWS에서 fine-tuning하기 위한 인프라를 한 번에 배포하는 CDK TypeScript 프로젝트입니다.

## Overview

상위 [`infra/isaaclab/`](../isaaclab/)이 만든 VPC와 EFS를 그대로 가져와서, 그 위에 GR00T 학습·추론에 필요한 자원을 추가로 올립니다. 결과적으로 학습 데이터·체크포인트는 IsaacLab DCV 인스턴스와 GR00T Batch 노드가 같은 EFS를 공유하므로 학습이 끝나자마자 시뮬레이션에서 바로 검증할 수 있습니다.

세 개의 CloudFormation 스택으로 나뉩니다.

| 스택 | 용도 | 배포 단위 |
|------|------|-----------|
| **GrootFinetuneShared** | 모든 사용자가 공유하는 ECR 레포지토리 2개(Batch + SageMaker 학습)와 컨테이너 이미지를 빌드하는 CodeBuild 프로젝트 2개, SageMaker Studio Domain | 계정당 1회 (관리자) |
| **GrootBatchTrain-`<userId>`** | AWS Batch Compute Environment, Job Queue, Job Definition. 학습 잡을 G6E GPU 인스턴스에서 실행 | 사용자별 |
| **GrootFinetuneSagemaker-`<userId>`** | S3 아티팩트 버킷, IAM 역할들, MLflow tracking server, SageMaker Studio UserProfile | 사용자별 |

## Prerequisites

- 부모 IsaacLab 스택이 먼저 배포되어 있어야 합니다 ([`../isaaclab/`](../isaaclab/))
- Node.js 18+, AWS CDK CLI
- 배포 리전에서 CDK Bootstrap 완료

## Getting Started

```bash
npm install

# 관리자가 한 번
npm run deploy:shared

# 사용자별 (Batch + SageMaker 두 스택을 동시에 배포)
npm run deploy -- -c userId=alice
```

`Shared` 스택을 배포하면 Batch용 컨테이너 이미지(약 15GB)가 CodeBuild에서 자동으로 빌드됩니다. 약 30분 소요. SageMaker 학습 컨테이너는 빌드 프로젝트만 등록되며, 별도로 트리거합니다.

배포가 끝나면 GR00T 학습/추론 코드(`../../groot/`)가 사용하는 `config.yaml`을 갱신합니다:

```bash
npx ts-node bin/update-config.ts --user-id alice --region us-east-1
```

이후부터는 `../../groot/`에서 `python training/scripts/run_training.py ...` 같은 명령으로 학습을 시작할 수 있습니다.

## Configuration

`cdk deploy -c key=value` 또는 `cdk.context.json`으로 전달합니다.

| 키 | 기본값 | 설명 |
|----|--------|------|
| `userId` | 배포 대상 계정 ID | 사용자별 스택 식별자. 모든 리소스 이름에 `-<userId>` 접미사가 붙음. 한 계정을 여러 명이 나눠 쓸 때만 지정 |
| `region` | `us-east-1` | 배포 리전 |
| `grootVersion` | `n1.6` | `n1.6` 또는 `n1.7`. CodeBuild가 빌드할 GR00T 버전 |
| `useStableGroot` | `true` | 검증된 릴리스 커밋 사용 (`false`면 최신) |
| `bucketName` | `groot-sm-artifacts-<userId>` | SageMaker 아티팩트 버킷 이름 |
| `mlflowSize` | `Small` | MLflow tracking server 사이즈 |

`bin/groot-finetune-app.ts`가 `IsaacLab-<Profile>-<userId>` 스택의 outputs에서 VPC ID, Private Subnet, EFS 정보를 자동으로 가져와 사용합니다. 결과는 `cdk.context.json`에 캐시되어 다음 배포에서 재사용됩니다. 부모 IsaacLab 스택을 찾지 못하면 per-user 스택(`GrootBatchTrain`, `GrootFinetuneSagemaker`)은 건너뛰고 `GrootFinetuneShared`만 배포 대상이 됩니다.

## Project Structure

```
infra/groot/
├── bin/
│   ├── groot-finetune-app.ts      CDK App 엔트리포인트
│   ├── resolve-parent-stack.ts    부모 IsaacLab 스택 자동 탐색
│   └── update-config.ts           CFN outputs을 ../../groot/config.yaml로 동기화
├── lib/
│   ├── groot-finetune-shared-stack.ts
│   ├── groot-batch-train-stack.ts
│   ├── groot-sagemaker-stack.ts
│   └── constructs/
├── assets/                          학습 컨테이너 buildspec, fine-tune 실행 스크립트, modality config 예시
├── docs/                            상세 가이드 + 트러블슈팅
├── cdk.json
└── package.json
```

## Cleanup

본인이 만든 사용자 스택만 정리합니다 (Shared는 다른 사용자가 공유하므로 그대로 둡니다).

```bash
npm run destroy -- -c userId=alice
```

## See Also

- [`docs/deployment-guide.md`](./docs/deployment-guide.md) — 배포 절차와 트러블슈팅
- [`../../groot/`](../../groot/) — 이 인프라 위에서 동작하는 학습·추론 코드
- [`../isaaclab/`](../isaaclab/) — 부모 IsaacLab 인프라
