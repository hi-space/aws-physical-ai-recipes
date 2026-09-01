# GR00T Fine-tuning Infrastructure

NVIDIA GR00T VLA 모델을 AWS에서 fine-tuning하기 위한 인프라를 한 번에 배포하는 CDK TypeScript 프로젝트입니다.

## Overview

상위 [`infra/isaaclab/`](../isaaclab/)이 만든 VPC와 공유 FSx for Lustre를 그대로 가져와서, 그 위에 GR00T 학습·추론에 필요한 자원을 추가로 올립니다. SageMaker 학습 잡이 S3로 export한 체크포인트가 FSx 자동 동기화(DRA)를 통해 IsaacLab DCV 인스턴스의 `/fsx/groot/...`에 나타나므로, 학습이 끝나자마자 시뮬레이션에서 바로 검증할 수 있습니다.

1인 1계정 전제의 **단일 스택**입니다.

| 스택 | 리소스 |
|------|--------|
| **GrootFinetune-`<ACCOUNT_ID>`** | ECR 레포지토리 2개(GR00T 런타임 `groot-runtime` + SageMaker 학습 `groot-sm-training`), 컨테이너 이미지를 빌드하는 CodeBuild 프로젝트 2개(`groot-runtime-build`, `groot-sm-training-build`), SageMaker Studio Domain + UserProfile, S3 아티팩트 버킷(`groot-sm-artifacts-<ACCOUNT_ID>`), 공유 FSx DRA, IAM 역할들, MLflow tracking server |

## Prerequisites

- 부모 IsaacLab 스택이 먼저 배포되어 있어야 합니다 ([`../isaaclab/`](../isaaclab/))
- Node.js 18+, AWS CDK CLI
- 배포 리전에서 CDK Bootstrap 완료

## Getting Started

```bash
npm install
npm run deploy
```

스택을 배포하면 GR00T 런타임 컨테이너 이미지(약 27GB)가 CodeBuild(`groot-runtime-build`)에서 자동으로 빌드됩니다. 약 30분 소요. SageMaker 학습 컨테이너는 빌드 프로젝트만 등록되며, `../../groot/training/scripts/trigger_build.py`로 별도 트리거합니다.

배포가 끝나면 GR00T 학습/추론 코드(`../../groot/`)가 사용하는 `config.yaml`을 갱신합니다:

```bash
npx ts-node bin/update-config.ts --region us-east-1
```

이후부터는 `../../groot/`에서 `python training/scripts/run_training.py ...` 같은 명령으로 학습을 시작할 수 있습니다.

## Configuration

`cdk deploy -c key=value` 또는 `cdk.context.json`으로 전달합니다.

| 키 | 기본값 | 설명 |
|----|--------|------|
| `region` | `us-east-1` | 배포 리전 |
| `grootVersion` | `n1.6` | `n1.6` 또는 `n1.7`. CodeBuild가 빌드할 GR00T 버전 |
| `useStableGroot` | `true` | 검증된 릴리스 커밋 사용 (`false`면 최신) |
| `bucketName` | `groot-sm-artifacts-<ACCOUNT_ID>` | SageMaker 아티팩트 버킷 이름 |
| `mlflowSize` | `Small` | MLflow tracking server 사이즈 |
| `vpcId` / `privateSubnetId` / `availabilityZone` / `fsxFileSystemId` | (자동 탐색) | 부모 스택 자동 탐색을 건너뛰는 수동 오버라이드 |

`bin/groot-finetune-app.ts`가 `IsaacLab-<Profile>-<ACCOUNT_ID>` 스택의 outputs에서 VPC ID, Private Subnet, 공유 FSx 정보를 자동으로 가져와 사용합니다. 결과는 `cdk.context.json`에 캐시되어 다음 배포에서 재사용됩니다. 부모 IsaacLab 스택이 없으면 배포가 실패하므로, 반드시 IsaacLab 스택을 먼저 배포하세요.

## Project Structure

```
infra/groot/
├── bin/
│   ├── groot-finetune-app.ts      CDK App 엔트리포인트
│   ├── resolve-parent-stack.ts    부모 IsaacLab 스택 자동 탐색
│   └── update-config.ts           CFN outputs을 ../../groot/config.yaml로 동기화
├── lib/
│   ├── groot-finetune-stack.ts    통합 스택 (ECR/CodeBuild/Studio/S3/MLflow)
│   └── constructs/
├── assets/                          학습 컨테이너 buildspec, fine-tune 실행 스크립트, modality config 예시
├── cdk.json
└── package.json
```

## Cleanup

```bash
npm run destroy
```

ECR 이미지·S3 오브젝트는 스택 삭제 전에 비워야 할 수 있습니다(오토 삭제가 설정된 리소스는 자동 정리).

## See Also

- [`docs/deployment-guide.md`](./docs/deployment-guide.md) — 배포 절차와 트러블슈팅
- [`../../groot/`](../../groot/) — 이 인프라 위에서 동작하는 학습·추론 코드
- [`../isaaclab/`](../isaaclab/) — 부모 IsaacLab 인프라
