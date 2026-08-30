import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface MlflowProps {
  namePrefix: string;
  artifactBucket: s3.CfnBucket;
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
  }
}
