/**
 * DcvInstanceConstruct
 *
 * NICE DCV가 설치된 EC2 인스턴스(GPU 또는 CPU 워크스테이션), IAM 역할, Secrets Manager Secret,
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
  /**
   * 워크스테이션 모드 (기본 gpu).
   * cpu: GPU가 없는 인스턴스. UserData에서 nvidia-driver.sh 단계만 생략한다.
   *      common.sh(데스크톱·DCV·ROS2), isaac-lab.sh(Docker 이미지 빌드),
   *      models-download.sh, fsx-mount.sh, code-server.sh는 GPU 모드와 동일하게 실행되어
   *      파일·이미지·경로가 같아진다.
   */
  workstationMode?: 'gpu' | 'cpu';
}

/**
 * DCV 인스턴스 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - Secrets Manager Secret (DCV 비밀번호 자동 생성, 32자, 구두점 제외)
 * - IAM Role (S3 전체, ECR 전체, SSM, SageMaker, Secrets Manager 읽기 - ARN 제한)
 * - Instance Profile
 * - EC2 Instance (GPU 또는 CPU 워크스테이션, 500GB EBS gp3, EBS 암호화 활성화)
 * - CloudFormation CreationPolicy (120분 타임아웃; UserData 약 25분 소요)
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
    const workstationMode = props.workstationMode ?? 'gpu';

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
                  'codebuild:ListBuildsForProject',
                ],
                Resource: '*',
              },
              {
                // 워크숍 문서의 `aws logs tail`(CodeBuild/SageMaker/Greengrass 로그 확인)
                Effect: 'Allow',
                Action: [
                  'logs:DescribeLogGroups',
                  'logs:DescribeLogStreams',
                  'logs:GetLogEvents',
                  'logs:FilterLogEvents',
                  'logs:StartLiveTail',
                  'logs:StopLiveTail',
                ],
                Resource: '*',
              },
              {
                // 모듈 7: HyperPod 배포 전 GPU 쿼터 확인
                Effect: 'Allow',
                Action: ['servicequotas:ListServiceQuotas', 'servicequotas:GetServiceQuota'],
                Resource: '*',
              },
              {
                // 모듈 7: code-server에서 HyperPod head node로 SSM 세션 접속
                Effect: 'Allow',
                Action: ['ssm:StartSession', 'ssm:TerminateSession', 'ssm:ResumeSession'],
                Resource: '*',
              },
              {
                // 모듈 10 §10.10: 잔여 리소스 감사(NAT GW/EIP/SG) + 수동 정리 폴백
                Effect: 'Allow',
                Action: [
                  'ec2:DescribeNatGateways',
                  'ec2:DescribeAddresses',
                  'ec2:DescribeSecurityGroups',
                  'ec2:DeleteNatGateway',
                  'ec2:ReleaseAddress',
                  'ec2:DeleteSecurityGroup',
                  'logs:DeleteLogGroup',
                ],
                Resource: '*',
              },
              {
                // UserData 부트스트랩: 루트 볼륨 gp3 throughput 상향 (CloudFormation의
                // AWS::EC2::Instance Ebs 속성은 Throughput을 지원하지 않아 부팅 후 수행)
                Effect: 'Allow',
                Action: ['ec2:DescribeVolumes', 'ec2:ModifyVolume'],
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
                // CDK v2 배포는 부트스트랩 롤(cdk-hnb659fds-*)을 AssumeRole 한다.
                // 이 인스턴스에서 infra/groot·hyperpod-training/infra를 수동 배포할 때 필요.
                Effect: 'Allow',
                Action: 'sts:AssumeRole',
                Resource: 'arn:aws:iam::*:role/cdk-*',
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
                // PutParameter: 모듈 3 §3.3.5에서 HF 토큰을 /groot/hf-token 에 저장
                Action: [
                  'ssm:GetParameter',
                  'ssm:GetParameters',
                  'ssm:DescribeParameters',
                  'ssm:PutParameter',
                ],
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
      `export WORKSTATION_MODE="${workstationMode}"`,
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
      '# 루트 볼륨 gp3 throughput 상향 (125 → 1000 MB/s) — Docker 이미지 압축 해제와 apt 설치가',
      '# 디스크에 막히지 않게 한다. CloudFormation의 Instance Ebs 속성은 Throughput을 지원하지',
      '# 않아 부팅 직후 modify-volume으로 처리한다 (온라인 적용, 실패해도 배포는 계속).',
      'INSTANCE_ID=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
      'ROOT_VOLUME_ID=$(aws ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" --query "Volumes[0].VolumeId" --output text --region ${AWS::Region})',
      'aws ec2 modify-volume --volume-id "$ROOT_VOLUME_ID" --throughput 1000 --region ${AWS::Region} || echo "[WARN] root volume throughput bump failed"',
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
      // cpu 워크스테이션(workshop-studio 프로필)에는 GPU가 없으므로 드라이버 단계를 생략한다.
      ...(workstationMode === 'cpu'
        ? ['echo "===== [$(date)] STAGE: nvidia-driver.sh (skipped: WORKSTATION_MODE=cpu) ====="']
        : [
            'echo "===== [$(date)] STAGE: nvidia-driver.sh ====="',
            'source /tmp/userdata-scripts/nvidia-driver.sh || { echo "[FAIL] nvidia-driver.sh failed"; USERDATA_EXIT=1; }',
          ]),
      ...(props.enableCloudWatch ? ['source /tmp/userdata-scripts/cloudwatch-agent.sh || { echo "[FAIL] cloudwatch-agent.sh failed"; USERDATA_EXIT=1; }'] : []),
      '',
      '# GNOME(ubuntu-desktop) 설치가 networkd/resolved를 재시작하며 DNS가 일시 붕괴하는',
      '# 레이스가 관측됨 — 네트워크 의존 단계를 시작하기 전에 DNS 복구를 확인한다.',
      'source /tmp/userdata-scripts/dns-guard.sh || true',
      '',
      '# isaac-lab.sh(Docker 이미지 빌드, 최장 단계)와 models-download.sh(6.1GiB 다운로드)는',
      '# 서로도, 이후의 fsx-mount/code-server와도 독립이므로 백그라운드로 병렬 실행한다.',
      '# 반드시 nvidia-driver.sh 이후에 시작해야 한다 — nvidia-driver.sh가 docker를 재시작하므로',
      '# 그 전에 시작한 docker pull/build가 중단된다. 로그는 섞이지 않게 별도 파일에 쓰고 완료 후 병합한다.',
      'echo "===== [$(date)] STAGE: isaac-lab.sh (background) ====="',
      'bash /tmp/userdata-scripts/isaac-lab.sh > /var/log/isaac-lab.log 2>&1 & ISAACLAB_PID=$!',
      'echo "===== [$(date)] STAGE: models-download.sh (background) ====="',
      'bash /tmp/userdata-scripts/models-download.sh > /var/log/models-download.log 2>&1 & MODELS_PID=$!',
      '',
      'echo "===== [$(date)] STAGE: fsx-mount.sh ====="',
      '# FSx 마운트 실패는 스크립트 내부에서 [WARN] 처리한다 (모듈 5에 s3 sync 폴백 존재)',
      'source /tmp/userdata-scripts/fsx-mount.sh || echo "[WARN] fsx-mount.sh failed"',
      ...((props.enableCodeServer ?? true) ? ['source /tmp/userdata-scripts/code-server.sh || { echo "[FAIL] code-server.sh failed"; USERDATA_EXIT=1; }'] : []),
      '',
      'echo "===== [$(date)] STAGE: waiting for background jobs (isaac-lab, models-download) ====="',
      'wait $ISAACLAB_PID || { echo "[FAIL] isaac-lab.sh failed"; USERDATA_EXIT=1; }',
      'cat /var/log/isaac-lab.log',
      'wait $MODELS_PID || { echo "[FAIL] models-download.sh failed"; USERDATA_EXIT=1; }',
      'cat /var/log/models-download.log',
      '',
      'trap - ERR',
      'set +e',
      '# cfn-signal 설치 실패는 곧 스택 행(타임아웃까지 대기)이므로 DNS를 한 번 더 확인',
      'source /tmp/userdata-scripts/dns-guard.sh || true',
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
            // 기본값(3000 IOPS / 125MB/s)이면 Isaac Sim 이미지(10GB+) 압축 해제와
            // apt 설치가 전부 디스크에 막힌다. gp3 throughput 1000MB/s의 전제 조건인
            // 4000 IOPS를 여기서 잡고, throughput은 CloudFormation의 Instance Ebs
            // 속성이 지원하지 않아 UserData 부트스트랩에서 modify-volume으로 올린다.
            iops: 4000,
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

    // cfn-signal의 --resource에는 인스턴스의 논리적 ID가 필요하다.
    // 폴백 분기까지 포함해 ${InstanceLogicalId}가 두 번 나오므로 전역 치환해야 한다.
    // 하나라도 남으면 CloudFormation이 "Unresolved resource dependencies"로 템플릿을 거부한다.
    const userDataWithLogicalId = userDataScript.replace(
      /\$\{InstanceLogicalId\}/g,
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
    // UserData 완료 시 cfn-signal을 수신하며, 타임아웃은 120분
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
