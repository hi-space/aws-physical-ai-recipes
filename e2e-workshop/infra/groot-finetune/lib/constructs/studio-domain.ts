import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface StudioDomainProps {
  domainName: string;
  vpcId: string;
  subnetIds: string[];
  /** 도메인 기본 실행 역할 ARN. UserProfile마다 자체 역할로 덮어씀. */
  defaultExecutionRoleArn: string;
  /** per-user 스택이 SSM에서 읽을 파라미터 이름. */
  domainIdParameterName: string;
}

/**
 * 계정 단위 공유 SageMaker Studio Domain.
 * - PublicInternetOnly + IAM auth.
 * - 도메인 ID를 SSM Parameter Store에 기록 → per-user 스택이 lookup으로 가져옴.
 */
export class StudioDomain extends Construct {
  public readonly domain: sagemaker.CfnDomain;

  constructor(scope: Construct, id: string, props: StudioDomainProps) {
    super(scope, id);

    this.domain = new sagemaker.CfnDomain(this, 'Domain', {
      domainName: props.domainName,
      authMode: 'IAM',
      appNetworkAccessType: 'PublicInternetOnly',
      vpcId: props.vpcId,
      subnetIds: props.subnetIds,
      defaultUserSettings: {
        executionRole: props.defaultExecutionRoleArn,
        studioWebPortal: 'ENABLED',
        defaultLandingUri: 'studio::',
      },
      tags: [{ key: 'Project', value: 'GR00T-N1.6' }],
    });

    new ssm.StringParameter(this, 'DomainIdParam', {
      parameterName: props.domainIdParameterName,
      stringValue: this.domain.attrDomainId,
      description: 'Shared SageMaker Studio Domain ID (per-user stack에서 lookup 사용)',
    });
  }
}
