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
import * as fsx from 'aws-cdk-lib/aws-fsx';
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
  /** 공유 FSx for Lustre 파일시스템 참조 (/fsx 마운트) */
  fsxFileSystem: fsx.CfnFileSystem;
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
  /** CloudWatch Agent 설치 여부 (기본값: false) */
  enableCloudWatch?: boolean;
  /** code-server (VSCode) 설치 여부 (기본값: true) */
  enableCodeServer?: boolean;
  /** GR00T 가중치 S3 사본 위치. 미지정 시 HuggingFace에서 다운로드 */
  grootWeightsUrl?: string;
  /** 모델·가중치를 내려받는 인스턴스 로컬 경로 (기본값: '/home/ubuntu/environment/models') */
  modelsDir?: string;
}

/**
 * DCV 인스턴스 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - Secrets Manager Secret (DCV 비밀번호 자동 생성, 32자, 구두점 제외)
 * - IAM Role (S3 전체, ECR 전체, SSM, SageMaker, Secrets Manager 읽기 - ARN 제한)
 * - Instance Profile
 * - EC2 Instance (GPU, 500GB EBS gp3, EBS 암호화 활성화)
 * - CloudFormation CreationPolicy (120분 타임아웃 - 가이드 안내 최대 소요 110분 대비 여유)
 * - UserData (모듈 순차 실행, 환경 변수 주입, cfn-signal + reboot)
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
    // EC2 인스턴스용 역할: S3 전체, ECR 전체, SSM, SageMaker, Secrets Manager 읽기
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
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
        'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess',
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
        {
          policyName: 'EbsExpandPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'ec2:DescribeInstances',
                  'ec2:DescribeVolumes',
                  'ec2:ModifyVolume',
                  'ec2:DescribeVolumesModifications',
                ],
                Resource: '*',
              },
            ],
          },
        },
        {
          policyName: 'GreengrassProvisionPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['iot:*', 'greengrass:*'],
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: [
                  'iam:GetRole',
                  'iam:CreateRole',
                  'iam:AttachRolePolicy',
                  'iam:GetPolicy',
                  'iam:GetRolePolicy',
                  'iam:PassRole',
                  'iam:CreatePolicy',
                  'iam:TagRole',
                  'iam:PutRolePolicy',
                  'iam:DeleteRolePolicy',
                ],
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: 'sts:GetCallerIdentity',
                Resource: '*',
              },
            ],
          },
        },
        {
          policyName: 'SageMakerCodeBuildCfnPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'sagemaker:CreateTrainingJob',
                  'sagemaker:DescribeTrainingJob',
                  'sagemaker:CreateModel',
                  'sagemaker:CreateEndpoint',
                  'sagemaker:CreateEndpointConfig',
                  'sagemaker:InvokeEndpoint',
                ],
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: [
                  'ecr:DescribeRepositories',
                  'codebuild:StartBuild',
                  'codebuild:BatchGetBuilds',
                ],
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: 's3:GetObject',
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: 'cloudformation:*',
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: 'iam:PassRole',
                Resource: '*',
                Condition: {
                  StringEquals: {
                    'iam:PassedToService': [
                      'sagemaker.amazonaws.com',
                      'codebuild.amazonaws.com',
                      'cloudformation.amazonaws.com',
                    ],
                  },
                },
              },
              {
                Effect: 'Allow',
                Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:DescribeParameters'],
                Resource: `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/groot/*`,
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
      `export ISAAC_LAB_VERSION="${props.versionProfile.isaacLabVersion ?? ''}"`,
      `export ROS2_DISTRO="${props.versionProfile.ros2Distro}"`,
      `export VERSION_PROFILE="${props.versionProfileName}"`,
      'export FSX_ID="${FsxFileSystemId}"',
      'export FSX_DNS_NAME="${FsxDnsName}"',
      'export FSX_MOUNT_NAME="${FsxMountName}"',
      'export REGION="${AWS::Region}"',
      'export ACCOUNT="${AWS::AccountId}"',
      'export SECRET_ID="${SecretId}"',
      `export GROOT_WEIGHTS_URL="${props.grootWeightsUrl ?? ''}"`,
      `export MODELS_DIR="${props.modelsDir ?? '/home/ubuntu/environment/models'}"`,
      '',
      '# apt가 대화형 프롬프트(debconf 다이얼로그)로 멈추지 않도록 강제',
      '# (keyboard-configuration 등이 입력을 기다리면 UserData가 영구 정지하고 신호 타임아웃으로 배포가 실패한다)',
      'export DEBIAN_FRONTEND=noninteractive',
      'export NEEDRESTART_MODE=a',
      '',
      '# UserData 로그 초기화 - 부트스트랩 첫 줄부터 /var/log/user-data.log에 기록 (source된 스크립트에도 상속)',
      'exec > >(tee -a /var/log/user-data.log) 2>&1',
      'echo "===== [$(date)] START: UserData bootstrap ====="',
      '',
      '# Wait for IMDS and network connectivity before S3 access',
      'for i in $(seq 1 30); do TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null) && curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/ >/dev/null 2>&1 && break; echo "Waiting for IMDS credentials ($i/30)..."; sleep 10; done',
      '',
      '# 자산 다운로드 실패는 즉시 [FAIL] 마커를 남긴다 - 침묵 실패 시 이후 모든 source가 no-op이 되어 원인 추적이 불가능하다',
      'aws s3 cp ${UserdataScriptsUrl} /tmp/userdata-scripts.zip || { echo "[FAIL] S3 download of userdata-scripts.zip failed"; exit 1; }',
      'if which unzip >/dev/null 2>&1; then unzip -o /tmp/userdata-scripts.zip -d /tmp/userdata-scripts || { echo "[FAIL] unzip of userdata-scripts failed"; exit 1; }; else python3 -m zipfile -e /tmp/userdata-scripts.zip /tmp/userdata-scripts || { echo "[FAIL] Python unzip of userdata-scripts failed"; exit 1; }; fi',
      'chmod +x /tmp/userdata-scripts/*.sh',
      '',
      'aws s3 cp ${WorkshopAssetsUrl} /tmp/workshop-assets.zip || { echo "[FAIL] S3 download of workshop-assets.zip failed"; exit 1; }',
      'if which unzip >/dev/null 2>&1; then unzip -o /tmp/workshop-assets.zip -d /tmp/workshop-assets || { echo "[FAIL] unzip of workshop-assets failed"; exit 1; }; else python3 -m zipfile -e /tmp/workshop-assets.zip /tmp/workshop-assets || { echo "[FAIL] Python unzip of workshop-assets failed"; exit 1; }; fi',
      'cp /tmp/workshop-assets/Dockerfile /tmp/workshop-dockerfile || { echo "[FAIL] Dockerfile copy failed"; exit 1; }',
      'cp /tmp/workshop-assets/distributed_run.bash /tmp/workshop-distributed-run || { echo "[FAIL] distributed_run.bash copy failed"; exit 1; }',
      '',
      'USERDATA_EXIT=0',
      "trap 'USERDATA_EXIT=1' ERR",
      'set -o pipefail',
      '',
      'echo "===== [$(date)] STAGE: common.sh ====="',
      'source /tmp/userdata-scripts/common.sh || { echo "[FAIL] common.sh failed"; USERDATA_EXIT=1; }',
      'echo "===== [$(date)] STAGE: nvidia-driver.sh ====="',
      'source /tmp/userdata-scripts/nvidia-driver.sh || { echo "[FAIL] nvidia-driver.sh failed"; USERDATA_EXIT=1; }',
      ...(props.enableCloudWatch ? ['source /tmp/userdata-scripts/cloudwatch-agent.sh || { echo "[FAIL] cloudwatch-agent.sh failed"; USERDATA_EXIT=1; }'] : []),
      'echo "===== [$(date)] STAGE: isaac-lab.sh ====="',
      'source /tmp/userdata-scripts/isaac-lab.sh || { echo "[FAIL] isaac-lab.sh failed"; USERDATA_EXIT=1; }',
      'echo "===== [$(date)] STAGE: models-download.sh ====="',
      'source /tmp/userdata-scripts/models-download.sh || { echo "[FAIL] models-download.sh failed"; USERDATA_EXIT=1; }',
      'echo "===== [$(date)] STAGE: fsx-mount.sh ====="',
      '# FSx 마운트 실패는 스크립트 내부에서 [WARN] 처리한다 (모듈 5에 s3 sync 폴백 존재)',
      'source /tmp/userdata-scripts/fsx-mount.sh || echo "[WARN] fsx-mount.sh failed"',
      ...((props.enableCodeServer ?? true) ? ['source /tmp/userdata-scripts/code-server.sh || { echo "[FAIL] code-server.sh failed"; USERDATA_EXIT=1; }'] : []),
      '',
      'trap - ERR',
      'set +e',
      'wget https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.zip',
      'unzip aws-cfn-bootstrap-py3-latest.zip',
      'cd aws-cfn-bootstrap-2.0/',
      'python3 setup.py install',
      '# cfn-signal 폴백: 설치 실패 시 PATH에서 탐색 (신호를 아예 못 보내면 타임아웃까지 대기하게 됨)',
      'if [ -x /usr/local/bin/cfn-signal ]; then /usr/local/bin/cfn-signal -e $USERDATA_EXIT --stack ${AWS::StackName} --resource ${InstanceLogicalId} --region ${AWS::Region}; elif which cfn-signal >/dev/null 2>&1; then cfn-signal -e $USERDATA_EXIT --stack ${AWS::StackName} --resource ${InstanceLogicalId} --region ${AWS::Region}; else echo "[WARN] cfn-signal not found - stack will wait for CreationPolicy timeout"; fi',
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
            volumeSize: 500,
            volumeType: 'gp3',
            encrypted: true,
          },
        },
      ],
      // Fn.sub로 CloudFormation 의사 참조 및 리소스 참조를 치환한 후 Base64 인코딩
      userData: cdk.Fn.base64(
        cdk.Fn.sub(userDataScript, {
          FsxFileSystemId: props.fsxFileSystem.ref,
          FsxDnsName: props.fsxFileSystem.attrDnsName,
          FsxMountName: props.fsxFileSystem.attrLustreMountName,
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
        FsxFileSystemId: props.fsxFileSystem.ref,
        FsxDnsName: props.fsxFileSystem.attrDnsName,
        FsxMountName: props.fsxFileSystem.attrLustreMountName,
        SecretId: secret.ref,
        UserdataScriptsUrl: userdataAsset.s3ObjectUrl,
        WorkshopAssetsUrl: workshopAsset.s3ObjectUrl,
      }),
    );

    // --- CreationPolicy ---
    // UserData 완료 시 cfn-signal을 수신하며, 타임아웃은 90분
    // DLAMI 사용으로 드라이버/Docker 사전 설치되어 UserData 실행 시간 단축
    (cfnInstance as cdk.CfnResource).cfnOptions.creationPolicy = {
      resourceSignal: {
        count: 1,
        timeout: 'PT120M',
      },
    };

    // 노출 속성 설정
    this.instance = cfnInstance;
  }
}
