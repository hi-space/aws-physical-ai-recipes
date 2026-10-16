import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * EKS 경로에서 학습 Job 파드가 tracking server 를 호출할 수 있게 하는 pod identity 설정.
 *
 * Slurm 경로는 노드 execution role 에 `sagemaker-mlflow:*` 를 직접 붙여 해결하지만
 * (constructs/hyperpod-cluster.ts), EKS 파드는 노드 역할을 물려받지 못한다. HyperPod EKS 노드에서
 * 파드의 IMDS(169.254.169.254) 접근은 막혀 있어 자격증명 조회 자체가 실패하므로
 * (2026-10-16 실측: 파드 안 `aws sts get-caller-identity` → NoCredentials), pod identity 가 유일한 경로다.
 */
export interface MlflowPodIdentityProps {
  /** association 의 clusterName 용. */
  clusterName: string;
  /** Pod Identity Agent 애드온 — association 이 이에 의존한다. */
  podIdentityAgent: eks.CfnAddon;
  /** 학습 Job 이 도는 네임스페이스. k8s-templates/render.sh 의 NAMESPACE 기본값과 팀 네임스페이스들. */
  namespaces: string[];
  /**
   * 파드가 쓸 ServiceAccount 이름. 기본 `default`.
   *
   * 모든 네임스페이스에 자동으로 존재하는 SA 를 쓰므로 Job 템플릿에 serviceAccountName 을
   * 적을 필요가 없고, task governance 가 나중에 만드는 팀 네임스페이스(hyperpod-ns-*)에도
   * 그대로 적용된다 (association 은 네임스페이스·SA 존재를 검증하지 않는다).
   */
  serviceAccountName?: string;
}

export interface MlflowProps {
  namePrefix: string;
  artifactBucket: s3.CfnBucket;
  /** 지정하면 EKS 학습 파드용 ServiceAccount + pod identity association 을 함께 만든다. */
  podIdentity?: MlflowPodIdentityProps;
}

export class MlflowConstruct extends Construct {
  public readonly trackingServerArn: string;
  public readonly trackingUri: string;

  constructor(scope: Construct, id: string, props: MlflowProps) {
    super(scope, id);
    const p = props.namePrefix;

    const mlflowRole = new iam.CfnRole(this, 'MlflowRole', {
      assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sagemaker.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess'],
      tags: [{ key: 'Name', value: `${p}-MLflow-Role` }],
    });

    const serverName = `${p}-mlflow`.toLowerCase();
    const trackingServer = new cdk.CfnResource(this, 'TrackingServer', {
      type: 'AWS::SageMaker::MlflowTrackingServer',
      properties: {
        TrackingServerName: serverName,
        ArtifactStoreUri: cdk.Fn.join('', ['s3://', props.artifactBucket.ref, '/mlflow-artifacts']),
        TrackingServerSize: 'Small',
        RoleArn: mlflowRole.attrArn,
        AutomaticModelRegistration: false,
        Tags: [{ Key: 'Name', Value: `${p}-MLflow` }],
      },
    });

    this.trackingServerArn = trackingServer.getAtt('TrackingServerArn').toString();
    this.trackingUri = `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:mlflow-tracking-server/${serverName}`;

    const trackingArnOut = new cdk.CfnOutput(this, 'MlflowTrackingArn', { value: this.trackingUri, description: 'MLflow Tracking ARN (for Python SDK: mlflow.set_tracking_uri)' });
    const presignedOut = new cdk.CfnOutput(this, 'MlflowPresignedUrlCommand', { value: `aws sagemaker create-presigned-mlflow-tracking-server-url --tracking-server-name ${serverName} --region ${cdk.Aws.REGION}`, description: 'Run this command to get MLflow UI URL (browser)' });
    // Pin the logical IDs so Module 8 can read them by name from the stack outputs.
    trackingArnOut.overrideLogicalId('MlflowTrackingArn');
    presignedOut.overrideLogicalId('MlflowPresignedUrlCommand');

    if (props.podIdentity) {
      this.grantPodAccess(props.podIdentity, props.artifactBucket, trackingServer);
    }
  }

  /**
   * 학습 파드용 pod identity association.
   *
   * 네임스페이스마다 association 이 하나씩 필요하다(association 은 namespace/serviceAccount 쌍에 1:1이고
   * 와일드카드를 받지 않는다). 역할은 하나를 공유한다.
   */
  private grantPodAccess(pi: MlflowPodIdentityProps, artifactBucket: s3.CfnBucket, trackingServer: cdk.CfnResource) {
    const podRole = new iam.Role(this, 'PodRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      description: 'HyperPod EKS training pods -> SageMaker managed MLflow',
    });
    // tracking server REST API(run/metric/param/tag 호출) 권한. 리소스는 trackingServer.getAtt 대신
    // 직접 조립한 ARN 을 쓴다 — getAtt 토큰은 tracking server 생성이 끝나야 값이 정해지므로
    // 정책이 서버에 암묵적으로 의존해 순환 참조/대기를 만든다.
    podRole.addToPolicy(new iam.PolicyStatement({
      sid: 'MlflowTrackingServerAccess',
      actions: ['sagemaker-mlflow:*'],
      resources: [this.trackingUri],
    }));
    // sagemaker-mlflow 플러그인은 artifact 업로드를 presigned URL 이 아니라 mlflow 의
    // S3ArtifactRepository 로 처리한다(S3PresignedArtifactRepo 가 이를 상속하고,
    // _SAGEMAKER_PRESIGNED_URL_UPLOAD 가 "true" 가 아니면 S3 직접 호출). 따라서 파드에
    // artifact prefix 에 대한 S3 권한이 따로 필요하다.
    const bucketArn = cdk.Fn.join('', ['arn:aws:s3:::', artifactBucket.ref]);
    podRole.addToPolicy(new iam.PolicyStatement({
      sid: 'MlflowArtifactStoreAccess',
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:GetObjectVersion'],
      resources: [cdk.Fn.join('', [bucketArn, '/mlflow-artifacts/*'])],
    }));
    podRole.addToPolicy(new iam.PolicyStatement({
      sid: 'MlflowArtifactStoreList',
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [bucketArn],
    }));

    const serviceAccount = pi.serviceAccountName ?? 'default';
    for (const namespace of pi.namespaces) {
      // 네임스페이스 이름이 리소스 ID 에 들어가므로 영숫자만 남긴다 (하이픈은 CDK construct ID 에서 허용되지만
      // 논리 ID 생성 시 제거되어 team-a/teama 가 충돌할 수 있다).
      const id = namespace.replace(/[^a-zA-Z0-9]/g, '');
      const association = new eks.CfnPodIdentityAssociation(this, `PodIdentity${id}`, {
        clusterName: pi.clusterName,
        namespace,
        serviceAccount,
        roleArn: podRole.roleArn,
      });
      association.addDependency(pi.podIdentityAgent);
      association.node.addDependency(trackingServer);
    }
  }
}
