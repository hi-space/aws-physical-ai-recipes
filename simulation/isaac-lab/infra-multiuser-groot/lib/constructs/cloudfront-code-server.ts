/**
 * CloudFrontCodeServerConstruct
 *
 * code-server(8888)에 HTTPS로 접속할 수 있도록
 * CloudFront Distribution을 생성하는 L1 Construct.
 *
 * CloudFront(HTTPS 443) → EC2 Origin(HTTP 8888)
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface CloudFrontCodeServerProps {
  /** DCV EC2 인스턴스 참조 */
  instance: ec2.CfnInstance;
  /** 리소스 Name 태그 접두사 */
  namePrefix: string;
}

export class CloudFrontCodeServerConstruct extends Construct {
  /** CloudFront Distribution 도메인 이름 */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontCodeServerProps) {
    super(scope, id);

    const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
      distributionConfig: {
        enabled: true,
        httpVersion: 'http2',
        comment: `${props.namePrefix} code-server`,
        origins: [
          {
            id: 'code-server-origin',
            domainName: props.instance.attrPublicDnsName,
            customOriginConfig: {
              httpPort: 8888,
              httpsPort: 443,
              originProtocolPolicy: 'http-only',
              originSslProtocols: ['TLSv1.2'],
            },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'code-server-origin',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          cachedMethods: ['GET', 'HEAD'],
          cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          originRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3',
          compress: true,
        },
      },
      tags: [{ key: 'Name', value: `${props.namePrefix}-CodeServer-CDN` }],
    });

    this.distributionDomainName = distribution.attrDomainName;
  }
}
