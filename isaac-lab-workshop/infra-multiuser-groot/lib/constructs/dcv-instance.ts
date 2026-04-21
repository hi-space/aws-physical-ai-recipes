/**
 * DcvInstanceConstruct
 *
 * NICE DCV가 설치된 GPU EC2 인스턴스, IAM 역할, Secrets Manager Secret,
 * CloudFormation CreationPolicy를 생성하는 L1 Construct.
 *
 * L1 Construct(Cfn* 클래스)를 사용하여 원본 CloudFormation 템플릿과
 * 1:1 대응을 유지하고, CDK synth 결과를 예측 가능하게 한다.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import * as path from 'path';
import { VersionProfile, VersionProfileName } from '../config/version-profiles';

/**
 * DcvInstanceConstruct Props
 */
export interface DcvInstanceProps {
  /** VPC 참조 */
  vpc: ec2.CfnVPC;
  /** 퍼블릭 서브넷 참조 */
  publicSubnet: ec2.CfnSubnet;
  /** DCV용 보안 그룹 참조 */
  dcvSecurityGroup: ec2.CfnSecurityGroup;
  /** EFS 파일 시스템 참조 */
  efsFileSystem: efs.CfnFileSystem;
  /** EFS 보안 그룹 참조 */
  efsSecurityGroup: ec2.CfnSecurityGroup;
  /** EC2 인스턴스 타입 (예: 'g6.12xlarge') */
  instanceType: string;
  /** 버전 프로필 설정 객체 */
  versionProfile: VersionProfile;
  /** 버전 프로필 이름 */
  versionProfileName: VersionProfileName;
  /** DCV AMI ID */
  amiId: string;
  /** 리소스 Name 태그 접두사 (예: 'IsaacLab-Stable-alice') */
  namePrefix: string;
  /** ECR 리포지토리 이름 (멀티 사용자 시 사용자별 분리) */
  ecrRepoName?: string;
  /** GR00T 리포지토리 URL (빈 문자열이면 GR00T 미설치) */
  grootRepoUrl?: string;
  /** GR00T 리포지토리 브랜치 */
  grootBranch?: string;
  /** CloudWatch Agent 설치 여부 (기본값: false) */
  enableCloudWatch?: boolean;
  /** code-server (VSCode) 설치 여부 (기본값: true) */
  enableCodeServer?: boolean;
}

/**
 * DCV 인스턴스 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - Secrets Manager Secret (DCV 비밀번호 자동 생성, 32자, 구두점 제외)
 * - IAM Role (S3 읽기, ECR 전체, EFS 전체, SSM, Secrets Manager 읽기 - ARN 제한)
 * - Instance Profile
 * - EC2 Instance (GPU, 200GB EBS gp3, EBS 암호화 활성화)
 * - CloudFormation CreationPolicy (60분 타임아웃)
 * - UserData (6개 모듈 순차 실행, 환경 변수 주입, cfn-signal + reboot)
 */
export class DcvInstanceConstruct extends Construct {
  /** DCV EC2 인스턴스 */
  public readonly instance: ec2.CfnInstance;
  /** Secrets Manager Secret ARN */
  public readonly secretArn: string;

  constructor(scope: Construct, id: string, props: DcvInstanceProps) {
    super(scope, id);

    const p = props.namePrefix;

    // --- Secrets Manager Secret ---
    // DCV 비밀번호 자동 생성 (32자, 구두점 제외)
    const secret = new secretsmanager.CfnSecret(this, 'DcvSecret', {
      description: 'DCV instance login password',
      generateSecretString: {
        secretStringTemplate: '{"username":"ubuntu"}',
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
        includeSpace: false,
      },
      tags: [{ key: 'Name', value: `${p}-Secret` }],
    });
    this.secretArn = secret.ref;

    // --- IAM Role ---
    // EC2 인스턴스용 역할: S3 읽기, ECR 전체, EFS 전체, SSM, Secrets Manager 읽기
    const role = new iam.CfnRole(this, 'DcvInstanceRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess',
        'arn:aws:iam::aws:policy/AmazonElasticFileSystemFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
        ...(props.enableCloudWatch ? ['arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'] : []),
      ],
      policies: [
        {
          policyName: 'SecretsManagerReadPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: 'secretsmanager:GetSecretValue',
                Resource: secret.ref,
              },
            ],
          },
        },
      ],
      tags: [{ key: 'Name', value: `${p}-Role` }],
    });

    // --- Instance Profile ---
    const instanceProfile = new iam.CfnInstanceProfile(this, 'DcvInstanceProfile', {
      roles: [role.ref],
    });

    // --- EFS 보안 그룹에 DCV SG 소스의 NFS 인그레스 규칙 추가 ---
    // DCV 인스턴스에서 EFS에 NFS(2049) 접근할 수 있도록
    // CfnSecurityGroupIngress를 별도 리소스로 생성하여 순환 참조 방지
    new ec2.CfnSecurityGroupIngress(this, 'EfsFromDcvIngress', {
      groupId: props.efsSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 2049,
      toPort: 2049,
      sourceSecurityGroupId: props.dcvSecurityGroup.ref,
    });

    // --- UserData 구성 ---
    // 셸 스크립트를 S3 Asset으로 업로드하고, UserData에서 다운로드 후 실행
    // (EC2 UserData 16KB 제한 회피)
    const userdataAsset = new s3_assets.Asset(this, 'UserdataScripts', {
      path: path.join(__dirname, '../../assets/userdata'),
    });

    const workshopAsset = new s3_assets.Asset(this, 'WorkshopAssets', {
      path: path.join(__dirname, '../../assets/workshop'),
    });

    // UserData 부트스트랩: 환경 변수 설정 → S3에서 스크립트 다운로드 → 순차 실행
    const userDataScript = [
      '#!/bin/bash -v',
      '',
      `export NVIDIA_DRIVER_VERSION="${props.versionProfile.nvidiaDriverVersion}"`,
      `export ISAAC_SIM_VERSION="${props.versionProfile.isaacSimVersion}"`,
      `export ROS2_DISTRO="${props.versionProfile.ros2Distro}"`,
      `export VERSION_PROFILE="${props.versionProfileName}"`,
      'export EFS_ID="${EfsFileSystemId}"',
      'export REGION="${AWS::Region}"',
      'export ACCOUNT="${AWS::AccountId}"',
      'export SECRET_ID="${SecretId}"',
      `export ECR_REPO_NAME="${props.ecrRepoName ?? 'isaaclab-batch'}"`,
      `export GROOT_REPO="${props.grootRepoUrl ?? ''}"`,
      `export GROOT_BRANCH="${props.grootBranch ?? 'n1.6-release'}"`,
      '',
      'aws s3 cp ${UserdataScriptsUrl} /tmp/userdata-scripts.zip',
      'unzip -o /tmp/userdata-scripts.zip -d /tmp/userdata-scripts',
      'chmod +x /tmp/userdata-scripts/*.sh',
      '',
      'aws s3 cp ${WorkshopAssetsUrl} /tmp/workshop-assets.zip',
      'unzip -o /tmp/workshop-assets.zip -d /tmp/workshop-assets',
      'cp /tmp/workshop-assets/Dockerfile /tmp/workshop-dockerfile',
      'cp /tmp/workshop-assets/distributed_run.bash /tmp/workshop-distributed-run',
      '',
      'USERDATA_EXIT=0',
      "trap 'USERDATA_EXIT=1' ERR",
      'set -o pipefail',
      '',
      'source /tmp/userdata-scripts/common.sh',
      'source /tmp/userdata-scripts/nvidia-driver.sh',
      ...(props.enableCloudWatch ? ['source /tmp/userdata-scripts/cloudwatch-agent.sh'] : []),
      'source /tmp/userdata-scripts/isaac-lab.sh',
      'source /tmp/userdata-scripts/efs-mount.sh',
      'source /tmp/userdata-scripts/groot.sh',
      ...((props.enableCodeServer ?? true) ? ['source /tmp/userdata-scripts/code-server.sh'] : []),
      '',
      'trap - ERR',
      'set +e',
      'wget https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.zip',
      'unzip aws-cfn-bootstrap-py3-latest.zip',
      'cd aws-cfn-bootstrap-2.0/',
      'python3 setup.py install',
      '/usr/local/bin/cfn-signal -e $USERDATA_EXIT --stack ${AWS::StackName} --resource ${InstanceLogicalId} --region ${AWS::Region}',
      '',
      'systemctl disable systemd-networkd-wait-online.service 2>/dev/null || true',
      '',
      'reboot',
    ].join('\n');

    // --- EC2 Instance ---
    const cfnInstance = new ec2.CfnInstance(this, 'DcvInstance', {
      imageId: props.amiId,
      instanceType: props.instanceType,
      subnetId: props.publicSubnet.ref,
      securityGroupIds: [props.dcvSecurityGroup.ref],
      iamInstanceProfile: instanceProfile.ref,
      blockDeviceMappings: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            volumeSize: 300,
            volumeType: 'gp3',
            encrypted: true,
          },
        },
      ],
      // Fn.sub로 CloudFormation 의사 참조 및 리소스 참조를 치환한 후 Base64 인코딩
      userData: cdk.Fn.base64(
        cdk.Fn.sub(userDataScript, {
          EfsFileSystemId: props.efsFileSystem.ref,
          SecretId: secret.ref,
          UserdataScriptsUrl: userdataAsset.s3ObjectUrl,
          WorkshopAssetsUrl: workshopAsset.s3ObjectUrl,
        }),
      ),
      tags: [{ key: 'Name', value: `${p}-Instance` }],
    });

    // cfn-signal의 --resource 값에 인스턴스의 논리적 ID를 사용해야 함
    // Fn.sub에서 ${InstanceLogicalId}를 치환하기 위해 UserData를 재구성
    // cfnInstance.logicalId를 사용하여 정확한 논리적 ID를 전달
    const userDataWithLogicalId = userDataScript.replace(
      '${InstanceLogicalId}',
      cfnInstance.logicalId,
    );

    // UserData를 논리적 ID가 포함된 버전으로 업데이트
    cfnInstance.userData = cdk.Fn.base64(
      cdk.Fn.sub(userDataWithLogicalId, {
        EfsFileSystemId: props.efsFileSystem.ref,
        SecretId: secret.ref,
        UserdataScriptsUrl: userdataAsset.s3ObjectUrl,
        WorkshopAssetsUrl: workshopAsset.s3ObjectUrl,
      }),
    );

    // --- CreationPolicy ---
    // UserData 완료 시 cfn-signal을 수신하며, 타임아웃은 60분
    // DLAMI 사용으로 드라이버/Docker 사전 설치되어 UserData 실행 시간 단축
    (cfnInstance as cdk.CfnResource).cfnOptions.creationPolicy = {
      resourceSignal: {
        count: 1,
        timeout: 'PT90M',
      },
    };

    // 노출 속성 설정
    this.instance = cfnInstance;
  }
}
