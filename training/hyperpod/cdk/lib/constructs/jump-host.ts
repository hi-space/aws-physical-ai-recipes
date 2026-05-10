import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface JumpHostProps {
  namePrefix: string;
  vpcId: string;
  publicSubnetId: string;
  clusterSecurityGroupId: string;
  lifecycleBucketName: string;
}

export class JumpHostConstruct extends Construct {
  public readonly instance: ec2.CfnInstance;
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: JumpHostProps) {
    super(scope, id);
    const p = props.namePrefix;

    const keyPair = new ec2.CfnKeyPair(this, 'KeyPair', {
      keyName: `${p.toLowerCase()}-jump-key`,
      keyType: 'ed25519',
      tags: [{ key: 'Name', value: `${p}-Jump-Key` }],
    });

    const jumpSG = new ec2.CfnSecurityGroup(this, 'JumpSG', {
      groupDescription: 'Jump host - SSH access',
      vpcId: props.vpcId,
      securityGroupIngress: [{
        ipProtocol: 'tcp',
        fromPort: 22,
        toPort: 22,
        cidrIp: '0.0.0.0/0',
        description: 'SSH from anywhere',
      }],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      tags: [{ key: 'Name', value: `${p}-Jump-SG` }],
    });

    new ec2.CfnSecurityGroupIngress(this, 'ClusterFromJump', {
      groupId: props.clusterSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      sourceSecurityGroupId: jumpSG.ref,
      description: 'SSH from jump host',
    });

    const role = new iam.CfnRole(this, 'JumpRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
      policies: [{
        policyName: 'S3LifecycleAccess',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
            Resource: [
              `arn:aws:s3:::${props.lifecycleBucketName}`,
              `arn:aws:s3:::${props.lifecycleBucketName}/*`,
            ],
          }],
        },
      }],
      tags: [{ key: 'Name', value: `${p}-Jump-Role` }],
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'JumpProfile', {
      roles: [role.ref],
    });

    const userData = cdk.Fn.base64(cdk.Fn.join('\n', [
      '#!/bin/bash',
      'set -e',
      `BUCKET="${props.lifecycleBucketName}"`,
      `REGION="${cdk.Aws.REGION}"`,
      '# Wait for cluster key to appear in S3 (uploaded by head node lifecycle)',
      'for i in $(seq 1 60); do',
      '  if aws s3 cp "s3://${BUCKET}/ssh/cluster_access_key" /home/ec2-user/.ssh/cluster_access_key --region $REGION 2>/dev/null; then',
      '    break',
      '  fi',
      '  sleep 10',
      'done',
      'aws s3 cp "s3://${BUCKET}/ssh/cluster_access_key.pub" /home/ec2-user/.ssh/cluster_access_key.pub --region $REGION 2>/dev/null || true',
      'chown ec2-user:ec2-user /home/ec2-user/.ssh/cluster_access_key /home/ec2-user/.ssh/cluster_access_key.pub 2>/dev/null || true',
      'chmod 600 /home/ec2-user/.ssh/cluster_access_key 2>/dev/null || true',
    ]));

    const amiParam = new cdk.CfnParameter(this, 'JumpAmi', {
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
    });

    const instance = new ec2.CfnInstance(this, 'Instance', {
      instanceType: 't3.micro',
      subnetId: props.publicSubnetId,
      securityGroupIds: [jumpSG.ref],
      keyName: keyPair.keyName,
      iamInstanceProfile: instanceProfile.ref,
      imageId: amiParam.valueAsString,
      userData,
      tags: [{ key: 'Name', value: `${p}-Jump` }],
    });

    this.instance = instance;
    this.publicIp = instance.attrPublicIp;

    new cdk.CfnOutput(this, 'JumpHostIp', { value: instance.attrPublicIp, description: 'Jump Host Public IP' });
    new cdk.CfnOutput(this, 'JumpKeyCommand', {
      value: cdk.Fn.join('', [
        'aws ssm get-parameter --name /ec2/keypair/',
        keyPair.attrKeyPairId,
        ' --with-decryption --query Parameter.Value --output text --region ',
        cdk.Aws.REGION,
      ]),
      description: 'Command to retrieve SSH private key',
    });
    new cdk.CfnOutput(this, 'SSHCommand', {
      value: cdk.Fn.join('', ['ssh -i ~/.ssh/', keyPair.keyName, '.pem ec2-user@', instance.attrPublicIp]),
      description: 'SSH command to jump host',
    });
  }
}
