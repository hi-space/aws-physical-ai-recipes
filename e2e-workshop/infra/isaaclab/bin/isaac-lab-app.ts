#!/usr/bin/env node
/**
 * CDK App 엔트리포인트
 *
 * Context에서 배포 설정을 읽어 IsaacLabStack을 생성한다.
 * 기본값이 적용되므로 별도 설정 없이 `cdk deploy`만으로 배포 가능하다.
 *
 * 멀티 사용자 지원:
 *   -c userId=alice 를 지정하면 스택 이름, ECR 리포지토리, 리소스 태그에
 *   사용자 식별자가 포함되어 같은 계정에서 여러 사용자가 독립 배포 가능하다.
 *
 * 리전 선택 우선순위:
 *   1. CDK Context: -c region=us-west-2 (가장 높은 우선순위)
 *   2. CDK_DEFAULT_REGION 환경 변수 (CDK CLI가 AWS 프로필에서 자동 설정)
 *
 * AWS Batch 분산 학습 인프라는 기본 비활성화되어 있다. 활성화하면 Batch용
 * IAM/보안 그룹/Launch Template이 생성되고, Isaac Lab 이미지를 ECR에 푸시한다
 * (이미지가 수십 GB라 배포 시간이 크게 늘어난다).
 *
 * 사용 예시:
 *   cdk deploy                                          # 기본 리전에 latest 프로필 배포
 *   cdk deploy -c userId=alice                           # 사용자별 독립 배포
 *   cdk deploy -c region=us-west-2 -c userId=bob
 *   cdk deploy -c versionProfile=stable -c userId=charlie # Isaac Sim 4.5.0 조합
 *   cdk deploy -c enableBatch=true                       # Batch 분산 학습까지 배포
 *
 * GR00T 가중치(약 6.1GiB)는 기본적으로 HuggingFace에서 받는다. 같은 리전의 S3
 * 사본을 지정하면 배포가 빨라지고 HuggingFace 가용성에 의존하지 않는다:
 *   cdk deploy -c grootWeightsUrl=s3://my-assets/GR00T-N1.6-3B/
 */
import * as cdk from 'aws-cdk-lib';
import { IsaacLabStack } from '../lib/isaac-lab-stack';

const app = new cdk.App();

// Context에서 Props 읽기 (기본값 적용)
const versionProfile = app.node.tryGetContext('versionProfile') ?? 'latest';
const inferenceInstanceType = app.node.tryGetContext('inferenceInstanceType') ?? '';
const preferredAZ = app.node.tryGetContext('preferredAZ') ?? 'auto';
const allowedCidr = app.node.tryGetContext('allowedCidr') ?? '0.0.0.0/0';
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';
const enableCloudWatch = (app.node.tryGetContext('enableCloudWatch') ?? 'false') === 'true';
const enableCodeServer = (app.node.tryGetContext('enableCodeServer') ?? 'true') === 'true';
const enableBatch = (app.node.tryGetContext('enableBatch') ?? 'false') === 'true';
const grootWeightsUrl = app.node.tryGetContext('grootWeightsUrl') ?? '';
const isaacSimVersion = app.node.tryGetContext('isaacSimVersion') ?? '';
const userId = app.node.tryGetContext('userId') ?? '';

// userId 유효성 검사: 영문소문자, 숫자, 하이픈만 허용 (스택 이름·ECR 리포지토리 호환)
if (userId && !/^[a-z0-9-]+$/.test(userId)) {
  throw new Error(`userId는 영문소문자, 숫자, 하이픈만 허용됩니다: '${userId}'`);
}

// 리전 선택: Context(-c region=xxx) > CDK_DEFAULT_REGION
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

// 스택 이름: IsaacLab-{Profile}[-{userId}]
const profilePart = versionProfile.charAt(0).toUpperCase() + versionProfile.slice(1);
const userSuffix = userId ? `-${userId}` : '';
const stackName = `IsaacLab-${profilePart}${userSuffix}`;

new IsaacLabStack(app, stackName, {
  env,
  versionProfile,
  inferenceInstanceType: inferenceInstanceType || undefined,
  preferredAZ,
  allowedCidr,
  vpcCidr,
  userId,
  enableCloudWatch,
  enableCodeServer,
  enableBatch,
  grootWeightsUrl,
  isaacSimVersion: isaacSimVersion || undefined,
});
