#!/usr/bin/env node
/**
 * CDK App 엔트리포인트
 *
 * Context에서 배포 설정을 읽어 IsaacLabStack을 생성한다.
 * 기본값이 적용되므로 별도 설정 없이 `cdk deploy`만으로 배포 가능하다.
 *
 * 식별자 규칙 (1인 1계정 전제):
 *   스택 이름과 리소스 태그의 식별자는 항상 배포 대상 계정 ID를 사용한다.
 *   예: IsaacLab-Latest-123456789012. 별도 인자 없이 이름이 항상 확정된다.
 *
 * 리전 선택 우선순위:
 *   1. CDK Context: -c region=us-west-2 (가장 높은 우선순위)
 *   2. CDK_DEFAULT_REGION 환경 변수 (CDK CLI가 AWS 프로필에서 자동 설정)
 *
 * 사용 예시:
 *   cdk deploy                                          # 기본 리전에 latest 프로필 배포
 *   cdk deploy -c region=us-west-2
 *   cdk deploy -c versionProfile=stable                  # Isaac Sim 4.5.0 조합
 *   cdk deploy -c profile=workshop-studio                # Workshop Studio 계정(CPU 워크스테이션)
 *
 * GR00T 가중치(약 6.1GiB)는 기본적으로 HuggingFace에서 받는다. 같은 리전의 S3
 * 사본을 지정하면 배포가 빨라지고 HuggingFace 가용성에 의존하지 않는다:
 *   cdk deploy -c grootWeightsUrl=s3://my-assets/GR00T-N1.6-3B/
 *
 * 모델·가중치를 내려받는 인스턴스 로컬 경로는 -c modelsDir 로 바꿀 수 있다.
 * 이 값은 UserData의 MODELS_DIR 환경 변수로 전달된다:
 *   cdk deploy -c modelsDir=/data/models
 */
import * as cdk from 'aws-cdk-lib';
import { IsaacLabStack } from '../lib/isaac-lab-stack';
import { parseDeploymentProfile } from '../lib/config/deployment-profile';

const app = new cdk.App();

// Context에서 Props 읽기 (기본값 적용)
const versionProfile = app.node.tryGetContext('versionProfile') ?? 'latest';
const inferenceInstanceType = app.node.tryGetContext('inferenceInstanceType') ?? '';
const preferredAZ = app.node.tryGetContext('preferredAZ') ?? 'auto';
const allowedCidr = app.node.tryGetContext('allowedCidr') ?? '0.0.0.0/0';
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';
const enableCloudWatch = (app.node.tryGetContext('enableCloudWatch') ?? 'false') === 'true';
const enableCodeServer = (app.node.tryGetContext('enableCodeServer') ?? 'true') === 'true';
const grootWeightsUrl = app.node.tryGetContext('grootWeightsUrl') ?? '';
const modelsDir = app.node.tryGetContext('modelsDir') ?? '/home/ubuntu/environment/models';
const isaacSimVersion = app.node.tryGetContext('isaacSimVersion') ?? '';
// 공유 FSx for Lustre (옵트인). 기본 워크플로우는 S3 → aws s3 sync 로 체크포인트를
// 가져오므로 FSx가 필요 없다. HyperPod와 스토리지를 합치려는 경우에만 켠다.
const enableFsx = (app.node.tryGetContext('enableFsx') ?? 'false') === 'true';
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
// 배포 프로필. workshop-studio = Workshop Studio 이벤트 계정(EC2 GPU 불가 → CPU 워크스테이션).
const profile = parseDeploymentProfile(app.node.tryGetContext('profile'));
// 식별자는 배포 대상 계정 ID를 사용한다(1인 1계정 전제). 스택 이름은 synth 시점에
// literal이어야 하므로 토큰(cdk.Aws.ACCOUNT_ID)이 아니라 CDK CLI가 주입하는 환경 변수를 읽는다.
const accountId = process.env.CDK_DEFAULT_ACCOUNT ?? '';

// 리전 선택: Context(-c region=xxx) > CDK_DEFAULT_REGION
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

// 스택 이름: IsaacLab-{Profile}-{accountId}
const profilePart = versionProfile.charAt(0).toUpperCase() + versionProfile.slice(1);
const accountSuffix = accountId ? `-${accountId}` : '';
const stackName = `IsaacLab-${profilePart}${accountSuffix}`;

new IsaacLabStack(app, stackName, {
  env,
  versionProfile,
  inferenceInstanceType: inferenceInstanceType || undefined,
  preferredAZ,
  allowedCidr,
  vpcCidr,
  accountId,
  enableCloudWatch,
  enableCodeServer,
  grootWeightsUrl,
  modelsDir,
  isaacSimVersion: isaacSimVersion || undefined,
  enableFsx,
  fsxCapacityGiB,
  profile,
});
