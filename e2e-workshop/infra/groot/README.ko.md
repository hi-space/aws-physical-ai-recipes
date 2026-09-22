# GR00T Fine-tuning Infrastructure

NVIDIA GR00T VLA 모델을 AWS에서 fine-tuning하기 위한 인프라를 한 번에 배포하는 CDK TypeScript 프로젝트입니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다. 상세 원문은 영문 README를 기준으로 삼으세요.

## Overview

상위 [`infra/isaaclab/`](../isaaclab/)이 만든 VPC를 그대로 가져와서, 그 위에 GR00T 학습·추론에 필요한 자원을 추가로 올립니다. SageMaker 학습 잡이 압축 해제된 체크포인트를 S3 아티팩트 버킷으로 export하고, IsaacLab DCV 인스턴스는 그 버킷을 Amazon S3 Files 파일시스템으로 `/mnt/s3/groot`에 마운트해(`sudo s3files-mount GrootFinetune-<ACCOUNT_ID> /mnt/s3/groot`) 다운로드 없이 시뮬레이션에서 바로 검증합니다(`aws s3 sync`로 받아도 됩니다). 부모 스택이 `-c enableFsx=true`로 배포된 경우에는 그 FSx에 DRA를 걸어 `/fsx/groot/...`에 자동으로 나타나게 합니다.

1인 1계정 전제의 **단일 스택**입니다.

| 스택 | 리소스 |
|------|--------|
| **GrootFinetune-`<ACCOUNT_ID>`** | ECR 레포지토리 2개(GR00T 런타임 `groot-runtime` + SageMaker 학습 `groot-sm-training`), SageMaker 학습 이미지를 빌드하는 CodeBuild 프로젝트(`groot-sm-training-build`), SageMaker Studio Domain + UserProfile, S3 아티팩트 버킷(`groot-sm-artifacts-<ACCOUNT_ID>-<REGION>`), 그 버킷 위의 S3 Files 파일시스템 + 마운트 타깃(NFS 2049 SG, 서비스 역할 `GR00TS3FilesRole-*`), (옵션) 공유 FSx DRA, IAM 역할들, MLflow tracking server |

## Prerequisites

- 부모 IsaacLab 스택이 먼저 배포되어 있어야 합니다 ([`../isaaclab/`](../isaaclab/))
- Node.js 18+, AWS CDK CLI
- 배포 리전에서 CDK Bootstrap 완료

## Getting Started

```bash
npm install
npm run deploy
```

스택을 배포하면 SageMaker 학습 컨테이너 이미지(`groot-sm-training-build`)가 CodeBuild에서 자동으로 빌드됩니다(약 30~40분). 스택이 배포 시 시작하는 빌드는 이것 하나입니다(새 계정의 CodeBuild 큐 한도가 1이라 둘을 동시에 시작하면 스택이 롤백됩니다). 프로젝트는 `../../groot/training/container/`를 S3 asset 으로 올리므로 그 안의 파일이 바뀌면 다음 `cdk deploy` 때 다시 빌드됩니다. 학습 Dockerfile 을 고친 뒤 배포 없이 재빌드하려면 `../../groot/training/scripts/trigger_build.py`를 씁니다.

GR00T 런타임 이미지(`groot-runtime`, 약 27GB; 모듈 2/3/5/6의 Policy Server 이미지)는 CodeBuild가 빌드하지 않습니다. GPU 워크스테이션(personal 프로필)에서 `assets/build_runtime_image.sh`로 빌드해 스택이 만든 ECR `groot-runtime`에 푸시합니다(멱등, `--force`로 재빌드, `GROOT_VERSION=n1.7`로 다른 버전). workshop-studio 프로필의 CPU 워크스테이션은 이 이미지를 쓰는 모듈을 모두 건너뛰므로 빌드가 필요 없습니다.

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
| `bucketName` | `groot-sm-artifacts-<ACCOUNT_ID>` | SageMaker 아티팩트 버킷 이름 |
| `mlflowSize` | `Small` | MLflow tracking server 사이즈 |
| `enableS3Files` | `true` | 아티팩트 버킷을 S3 Files 파일시스템으로 노출하고 부모 프라이빗 서브넷에 마운트 타깃을 만든다. Output `S3FilesFileSystemId`, `S3FilesMountCommand` 제공. `false`면 생략(체크포인트는 `aws s3 sync`) |
| `vpcId` / `privateSubnetId` / `availabilityZone` / `vpcCidr` / `fsxFileSystemId` | (자동 탐색) | 부모 스택 자동 탐색을 건너뛰는 수동 오버라이드 (`vpcCidr`는 S3 Files 마운트 타깃 SG 의 NFS 인바운드 소스) |

`bin/groot-finetune-app.ts`가 `IsaacLab-<Profile>-<ACCOUNT_ID>` 스택의 outputs에서 VPC ID, Private Subnet, VPC CIDR, (있으면) 공유 FSx ID를 자동으로 가져와 사용합니다. 결과는 `cdk.context.json`에 캐시되어 다음 배포에서 재사용됩니다 — 부모 스택의 FSx를 없앤 뒤 재배포할 때는 `cdk.context.json`의 `fsxFileSystemId`를 지워야 DRA가 생성되지 않습니다. 부모 IsaacLab 스택이 없으면 배포가 실패하므로, 반드시 IsaacLab 스택을 먼저 배포하세요.

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
