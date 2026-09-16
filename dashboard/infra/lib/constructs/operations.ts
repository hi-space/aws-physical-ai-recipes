import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class OperationsConstruct extends Construct {
  readonly project: codebuild.Project;
  constructor(scope: Construct, id: string, props: { sourcePath: string; clusterName: string; name: string; vpc: ec2.IVpc; securityGroup: ec2.ISecurityGroup }) {
    super(scope, id);
    const source = new assets.Asset(this, 'Source', { path: props.sourcePath, exclude: ['__pycache__'] });
    this.project = new codebuild.Project(this, 'Project', {
      projectName: `${props.name}-operations`,
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL, privileged: false },
      vpc: props.vpc, subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, securityGroups: [props.securityGroup],
      environmentVariables: { EKS_CLUSTER_NAME: { value: props.clusterName } },
      timeout: cdk.Duration.minutes(20),
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN }) } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: [
            'python -c "import urllib.request,hashlib,pathlib,os; u=\'https://dl.k8s.io/release/v1.34.2/bin/linux/amd64/kubectl\'; b=urllib.request.urlopen(u).read(); h=urllib.request.urlopen(u+\'.sha256\').read().decode().strip(); assert hashlib.sha256(b).hexdigest()==h; p=pathlib.Path(\'/usr/local/bin/kubectl\'); p.write_bytes(b); p.chmod(0o755)"',
          ] },
          build: { commands: ['python apply_addons.py --cluster "$EKS_CLUSTER_NAME" --region "$AWS_REGION"'] },
        },
      }),
    });
    source.grantRead(this.project);
  }
}
