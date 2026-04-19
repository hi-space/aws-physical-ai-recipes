/**
 * IsaacLabStack 메인 스택
 *
 * 4개의 Construct를 조합하여 Isaac Lab 환경 전체 인프라를 구성한다.
 * 조합 순서: Networking → EFS → DCV → Batch
 *
 * 멀티 사용자 지원:
 *   userId가 지정되면 ECR 리포지토리명과 리소스 태그에 사용자 식별자가 포함되어
 *   같은 계정에서 여러 사용자가 독립적으로 배포할 수 있다.
 *
 * CfnMapping을 사용하여 CloudFormation의 FindInMap으로 리전별 AMI를 조회한다.
 * CDK synth 시점에는 리전이 확정되지 않으므로, 런타임에 리전을 결정하는 방식이다.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VERSION_PROFILES, VersionProfileName } from './config/version-profiles';
import { DCV_AMI_MAPPING, BATCH_AMI_MAPPING } from './config/ami-mappings';
import { NetworkingConstruct } from './constructs/networking';
import { EfsStorageConstruct } from './constructs/efs-storage';
import { DcvInstanceConstruct } from './constructs/dcv-instance';
import { BatchInfraConstruct } from './constructs/batch-infra';
import { CloudFrontCodeServerConstruct } from './constructs/cloudfront-code-server';
import { AzSelectorConstruct, DEFAULT_INSTANCE_TYPE_FALLBACK } from './constructs/az-selector';

/**
 * IsaacLabStack Props
 */
export interface IsaacLabStackProps extends cdk.StackProps {
  /** 버전 프로필 이름 (stable, latest) */
  versionProfile: VersionProfileName;
  /** DCV 인스턴스 타입 (기본값: 'g6.12xlarge') */
  inferenceInstanceType?: string;
  /** AZ 선택: 'auto' 또는 '0'~'5' 인덱스 (기본값: 'auto') */
  preferredAZ?: string;
  /** DCV 보안 그룹 인바운드 소스 CIDR (기본값: '0.0.0.0/0') */
  allowedCidr?: string;
  /** 사용자 식별자 (멀티 사용자 배포 시 스택·리소스 격리용, 기본값: '') */
  userId?: string;
  /** VPC CIDR (기본값: '10.0.0.0/16') */
  vpcCidr?: string;
  /** GR00T 리포지토리 URL (지정 시 GR00T 추론 서버 설치) */
  grootRepoUrl?: string;
  /** GR00T 리포지토리 브랜치 (기본값: 'main') */
  grootBranch?: string;
  /** CloudWatch Agent 설치 여부 (기본값: false) */
  enableCloudWatch?: boolean;
  /** code-server (VSCode) 설치 여부 (기본값: true) */
  enableCodeServer?: boolean;
}

/**
 * Isaac Lab 환경 메인 스택
 *
 * Networking, EFS, DCV Instance, Batch 인프라를 조합하여
 * 원클릭 배포 가능한 Isaac Lab 환경을 구성한다.
 */
export class IsaacLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IsaacLabStackProps) {
    super(scope, id, props);

    // --- Props 기본값 적용 ---
    const instanceType = props.inferenceInstanceType ?? 'g6.12xlarge';
    const preferredAZ = props.preferredAZ ?? 'auto';
    const allowedCidr = props.allowedCidr ?? '0.0.0.0/0';
    const userId = props.userId ?? '';

    // --- 리소스 Name 태그 접두사 (스택 이름과 동일 패턴) ---
    const profilePart = props.versionProfile.charAt(0).toUpperCase() + props.versionProfile.slice(1);
    const userSuffix = userId ? `-${userId}` : '';
    const namePrefix = `IsaacLab-${profilePart}${userSuffix}`;

    // --- 사용자별 ECR 리포지토리 이름 ---
    const ecrRepoName = userId ? `isaaclab-batch-${userId}` : 'isaaclab-batch';

    // --- 사용자 태그 (모든 리소스에 자동 적용) ---
    if (userId) {
      cdk.Tags.of(this).add('UserId', userId);
    }

    // --- 버전 프로필 조회 ---
    const profile = VERSION_PROFILES[props.versionProfile];

    // --- AMI 매핑을 CfnMapping으로 변환 ---
    // DCV AMI 매핑: DCV_AMI_MAPPING은 이미 Record<string, Record<string, string>> 형식
    const dcvAmiMapping = new cdk.CfnMapping(this, 'DcvAmiMapping', {
      mapping: DCV_AMI_MAPPING,
    });

    // Batch AMI 매핑: BATCH_AMI_MAPPING은 Record<string, string>이므로
    // CfnMapping 형식(Record<string, Record<string, string>>)으로 래핑
    const batchAmiMappingData: Record<string, Record<string, string>> = {};
    for (const [region, amiId] of Object.entries(BATCH_AMI_MAPPING)) {
      batchAmiMappingData[region] = { ami: amiId };
    }
    const batchAmiMapping = new cdk.CfnMapping(this, 'BatchAmiMapping', {
      mapping: batchAmiMappingData,
    });

    // AMI ID 조회 (CloudFormation FindInMap — 배포 시점에 리전 결정)
    const dcvAmiId = dcvAmiMapping.findInMap(cdk.Aws.REGION, profile.ubuntuVersion);
    const batchAmiId = batchAmiMapping.findInMap(cdk.Aws.REGION, 'ami');

    // --- AZ 자동 탐색 (preferredAZ === 'auto'일 때) ---
    // Custom Resource Lambda로 실제 GPU capacity가 있는 AZ를 탐색한다.
    // inferenceInstanceType이 지정되면 해당 타입만 시도.
    // 미지정(기본값)이면 fallback 리스트를 순차 시도.
    // preferredAZ가 인덱스('0'~'5')이면 Lambda 탐색을 건너뛰고 해당 인덱스의 AZ를 직접 사용.
    let resolvedAZ: string | undefined;
    let resolvedInstanceType: string = instanceType;
    if (preferredAZ === 'auto') {
      // 인스턴스 타입이 명시적으로 지정되었으면 해당 타입만, 아니면 fallback 리스트 사용
      const instanceTypes = props.inferenceInstanceType
        ? [props.inferenceInstanceType]
        : DEFAULT_INSTANCE_TYPE_FALLBACK;

      const azSelector = new AzSelectorConstruct(this, 'AzSelector', {
        instanceTypes,
        amiId: dcvAmiId,
      });
      resolvedAZ = azSelector.availabilityZone;
      resolvedInstanceType = azSelector.resolvedInstanceType;
    }

    // --- [1/5] NetworkingConstruct ---
    // VPC, 서브넷, IGW, NAT, S3 Endpoint, Flow Log, DCV SG
    const enableCodeServer = props.enableCodeServer ?? true;

    const networking = new NetworkingConstruct(this, 'Networking', {
      namePrefix,
      preferredAZ,
      allowedCidr,
      resolvedAZ,
      vpcCidr: props.vpcCidr,
      enableGroot: !!props.grootRepoUrl,
      enableCodeServer,
    });

    // --- [2/5] EfsStorageConstruct ---
    // EFS 파일 시스템 + Mount Target (Networking 의존)
    const efsStorage = new EfsStorageConstruct(this, 'EfsStorage', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnet: networking.privateSubnet,
      vpcCidr: props.vpcCidr,
    });

    // --- [3/5] DcvInstanceConstruct ---
    // DCV EC2 인스턴스 (Networking, EFS 의존)
    const dcvInstance = new DcvInstanceConstruct(this, 'DcvInstance', {
      namePrefix,
      vpc: networking.vpc,
      publicSubnet: networking.publicSubnet,
      dcvSecurityGroup: networking.dcvSecurityGroup,
      efsFileSystem: efsStorage.fileSystem,
      efsSecurityGroup: efsStorage.securityGroup,
      instanceType: resolvedInstanceType,
      versionProfile: profile,
      versionProfileName: props.versionProfile,
      amiId: dcvAmiId,
      ecrRepoName,
      grootRepoUrl: props.grootRepoUrl,
      grootBranch: props.grootBranch,
      enableCloudWatch: props.enableCloudWatch,
      enableCodeServer,
    });

    // --- [4/5] CloudFrontCodeServerConstruct (code-server 활성화 시만 생성) ---
    let codeServerCdn: CloudFrontCodeServerConstruct | undefined;
    if (enableCodeServer) {
      codeServerCdn = new CloudFrontCodeServerConstruct(this, 'CodeServerCdn', {
        instance: dcvInstance.instance,
        namePrefix,
      });
    }

    // --- [5/5] BatchInfraConstruct ---
    // Batch Launch Template + IAM (Networking, EFS 의존)
    const batchInfra = new BatchInfraConstruct(this, 'BatchInfra', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnet: networking.privateSubnet,
      efsSecurityGroup: efsStorage.securityGroup,
      batchAmiId,
    });

    // --- CfnOutput ---
    new cdk.CfnOutput(this, 'InstanceId', {
      value: dcvInstance.instance.ref,
      description: 'DCV Instance ID',
    });

    new cdk.CfnOutput(this, 'DcvUrl', {
      value: cdk.Fn.join('', ['https://', dcvInstance.instance.attrPublicIp, ':8443']),
      description: 'DCV Access URL',
    });

    if (codeServerCdn) {
      new cdk.CfnOutput(this, 'CodeServerUrl', {
        value: cdk.Fn.join('', ['https://', codeServerCdn.distributionDomainName]),
        description: 'code-server (VSCode) Access URL via CloudFront',
      });
    }

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: networking.logGroup.ref,
      description: 'VPC Flow Log Group Name',
    });

    new cdk.CfnOutput(this, 'LogGroupArn', {
      value: networking.logGroup.attrArn,
      description: 'VPC Flow Log Group ARN',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: dcvInstance.secretArn,
      description: 'DCV Password Secret ARN',
    });

    new cdk.CfnOutput(this, 'VersionProfile', {
      value: props.versionProfile,
      description: 'Selected Version Profile',
    });

    new cdk.CfnOutput(this, 'BatchLaunchTemplateId', {
      value: batchInfra.launchTemplate.ref,
      description: 'Batch Launch Template ID',
    });

    new cdk.CfnOutput(this, 'BatchInstanceProfileArn', {
      value: batchInfra.instanceProfileArn,
      description: 'Batch Instance Profile ARN',
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: efsStorage.fileSystem.ref,
      description: 'EFS File System ID',
    });

    new cdk.CfnOutput(this, 'PrivateSubnetId', {
      value: networking.privateSubnet.ref,
      description: 'Private Subnet ID',
    });

    new cdk.CfnOutput(this, 'BatchSecurityGroupId', {
      value: batchInfra.securityGroup.ref,
      description: 'Batch Security Group ID',
    });

    if (userId) {
      new cdk.CfnOutput(this, 'UserId', {
        value: userId,
        description: 'User identifier for this deployment',
      });
    }
  }
}
