# GrootFinetune 스택 수동 배포 가이드

이 워크샵은 개인 AWS 계정에서 진행합니다 (Workshop Studio 이벤트 계정은 GPU `g` 계열 인스턴스를 허용하지 않음). 기본 경로는 프로비저너 템플릿(`e2e-workshop-provisioner.yaml`)이 이 스택을 자동 배포하는 것이고,
이 문서는 **CDK로 이 스택만 직접 배포**할 때(방법 2, 또는 파라미터를 바꿔 재배포할 때)의 절차입니다.

## 어디서 배포하나

두 경로 모두 지원합니다.

1. **DCV 인스턴스(code-server 터미널)에서 배포** — 권장. 모듈 1의 IsaacLab 스택이 만든
   EC2 인스턴스에는 Node.js와 AWS 자격증명(인스턴스 롤)이 이미 준비되어 있다.
2. 로컬 워크스테이션 / CloudShell — AWS 자격증명과 Node.js 18+만 있으면 동일하게 동작.

## 사전 조건

| 항목 | 내용 |
|------|------|
| 부모 스택 | `IsaacLab-Latest-<ACCOUNT_ID>` (또는 `-Stable-`)가 배포 완료 상태여야 한다. 이 스택의 VPC/Subnet/FSx를 자동 탐색해 사용한다. |
| Node.js | 18 이상 (`node --version`) |
| CDK Bootstrap | 배포 리전에 최초 1회: `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1` |
| IAM (DCV 인스턴스에서 배포 시) | DCV 인스턴스 롤에 `sts:AssumeRole` on `arn:aws:iam::*:role/cdk-*` 권한이 포함되어 있다(IsaacLab 스택이 부여). CDK v2는 배포 시 부트스트랩 롤(`cdk-hnb659fds-deploy-role-...` 등)을 AssumeRole 하는 방식이라 이 권한만 있으면 된다. |
| IAM (그 외 환경) | CloudFormation/IAM/ECR/CodeBuild/SageMaker/S3/SSM/FSx를 만들 수 있는 자격증명 + 위와 동일한 cdk-* AssumeRole 경로 |

## 배포 절차

```bash
# 1) 레포 클론 (이미 있으면 git pull)
git clone --depth 1 -b feat/e2e-workshop https://github.com/hi-space/aws-physical-ai-recipes.git ~/aws-physical-ai-recipes
cd ~/aws-physical-ai-recipes/e2e-workshop/infra/groot

# 2) 의존성 설치
npm install

# 3) (리전 최초 1회) CDK Bootstrap
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${ACCOUNT_ID}/us-east-1

# 4) 배포 (~15분 + 런타임 이미지 CodeBuild ~30분이 백그라운드로 이어짐)
npm run deploy -- -c region=us-east-1

# 5) 학습/추론 코드가 읽는 config.yaml 갱신
npx ts-node bin/update-config.ts --region us-east-1
```

배포되는 스택 이름은 `GrootFinetune-<ACCOUNT_ID>` 하나입니다. 배포 직후 CodeBuild
`groot-runtime-build`가 자동 트리거되어 GR00T 런타임 이미지(~27GB)를 ECR
`groot-runtime`에 푸시합니다(약 30분). 빌드 상태 확인:

```bash
aws codebuild list-builds-for-project --project-name groot-runtime-build --max-items 1
aws ecr describe-images --repository-name groot-runtime --query 'imageDetails[].imageTags'
```

## 파라미터

`-c key=value` 형태로 전달합니다. 전체 목록은 [README](../README.md#configuration) 참조.
대표적으로:

```bash
# GR00T N1.7 런타임 이미지로 빌드
npm run deploy -- -c grootVersion=n1.7

# 부모 스택 자동 탐색을 건너뛰고 네트워크를 직접 지정
npm run deploy -- -c vpcId=vpc-xxxx -c privateSubnetId=subnet-xxxx \
  -c availabilityZone=us-east-1a -c fsxFileSystemId=fs-xxxx

# Workshop Studio 이벤트 계정: TransformDataset을 ml.g5.2xlarge로 (update-config.ts가 config.yaml에 기록)
npm run deploy -- -c profile=workshop-studio
```

## 트러블슈팅

| 증상 | 원인/해결 |
|------|-----------|
| `No parent IsaacLab stack found` | IsaacLab 스택 미배포 또는 다른 리전. `-c region=`을 IsaacLab과 동일하게 지정. |
| `is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::...:role/cdk-...` | 배포 자격증명에 cdk-* AssumeRole 권한 없음. DCV 인스턴스라면 IsaacLab 스택을 최신 코드로 업데이트해 롤 정책을 반영. |
| `SSM parameter /cdk-bootstrap/... not found` | 해당 리전에 CDK Bootstrap 미실행. 위 3) 실행. |
| Studio Domain `RESOURCE_IN_USE` | 계정에 같은 이름(physical-ai-studio)의 도메인이 이미 존재. 콘솔에서 기존 도메인 삭제 후 재배포. |
| 스택 삭제가 ECR/S3에서 멈춤 | 이미지/오브젝트가 남아 있는 경우. `aws ecr batch-delete-image`, `aws s3 rm --recursive` 후 재시도. |
