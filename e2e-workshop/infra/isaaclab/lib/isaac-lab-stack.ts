/**
 * IsaacLabStack 메인 스택
 *
 * Construct를 조합하여 Isaac Lab 환경 전체 인프라를 구성한다.
 * 조합 순서: Networking → FSx → AzSelector(조건부) → DCV → CloudFront(조건부)
 * 배포 프로필(-c profile): personal(GPU 워크스테이션) | workshop-studio(CPU 워크스테이션)
 *
 * 식별자 규칙 (1인 1계정 전제):
 *   스택 이름과 리소스 태그에는 배포 대상 계정 ID가 식별자로 포함된다.
 *
 * CfnMapping을 사용하여 CloudFormation의 FindInMap으로 리전별 AMI를 조회한다.
 * CDK synth 시점에는 리전이 확정되지 않으므로, 런타임에 리전을 결정하는 방식이다.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VERSION_PROFILES, VersionProfileName } from './config/version-profiles';
import { DCV_AMI_MAPPING } from './config/ami-mappings';
import { NetworkingConstruct } from './constructs/networking';
import { FsxStorageConstruct } from './constructs/fsx-storage';
import { DcvInstanceConstruct } from './constructs/dcv-instance';
import { CloudFrontCodeServerConstruct } from './constructs/cloudfront-code-server';
import { AzSelectorConstruct, DEFAULT_INSTANCE_TYPE_FALLBACK, CPU_INSTANCE_TYPE_FALLBACK } from './constructs/az-selector';
import { DeploymentProfile } from './config/deployment-profile';

/**
 * IsaacLabStack Props
 */
export interface IsaacLabStackProps extends cdk.StackProps {
  /** 버전 프로필 이름 (stable, latest) */
  versionProfile: VersionProfileName;
  /** DCV 인스턴스 타입 (기본값: personal은 'g6e.4xlarge', workshop-studio는 'm6i.4xlarge') */
  inferenceInstanceType?: string;
  /** AZ 선택: 'auto' 또는 '0'~'5' 인덱스 (기본값: 'auto') */
  preferredAZ?: string;
  /** DCV 보안 그룹 인바운드 소스 CIDR (기본값: '0.0.0.0/0') */
  allowedCidr?: string;
  /** 배포 대상 계정 ID (리소스 태그·Output 식별자, 기본값: '') */
  accountId?: string;
  /** VPC CIDR (기본값: '10.0.0.0/16') */
  vpcCidr?: string;
  /** CloudWatch Agent 설치 여부 (기본값: false) */
  enableCloudWatch?: boolean;
  /** code-server (VSCode) 설치 여부 (기본값: true) */
  enableCodeServer?: boolean;
  /** GR00T 가중치 S3 사본 위치. 미지정 시 HuggingFace에서 다운로드 */
  grootWeightsUrl?: string;
  /** 모델·가중치를 내려받는 인스턴스 로컬 경로 (기본값: '/home/ubuntu/environment/models') */
  modelsDir?: string;
  /** 공유 FSx for Lustre 용량 GiB (PERSISTENT_2, 기본값: 1200) */
  fsxCapacityGiB?: number;
  /** Isaac Sim 버전 오버라이드 (프로필 기본값 대신 사용, 예: '5.1.0') */
  isaacSimVersion?: string;
  /** 배포 프로필 (기본 personal). workshop-studio 는 CPU 워크스테이션 */
  profile?: DeploymentProfile;
}

/**
 * Isaac Lab 환경 메인 스택
 *
 * Networking, FSx, DCV Instance를 조합하여
 * 원클릭 배포 가능한 Isaac Lab 환경을 구성한다.
 */
export class IsaacLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IsaacLabStackProps) {
    super(scope, id, props);

    // --- Props 기본값 적용 ---
    const preferredAZ = props.preferredAZ ?? 'auto';
    const allowedCidr = props.allowedCidr ?? '0.0.0.0/0';
    const accountId = props.accountId ?? '';
    const profile: DeploymentProfile = props.profile ?? 'personal';
    const cpuWorkstation = profile === 'workshop-studio';
    // 기본 타입은 프로필에 따른다. preferredAZ 를 인덱스로 지정해 AZ 탐색을 건너뛰는 경우에도
    // workshop-studio 는 CPU 워크스테이션을 써야 하므로 CPU fallback 목록의 첫 타입을 기본값으로 한다.
    const instanceType =
      props.inferenceInstanceType ?? (cpuWorkstation ? CPU_INSTANCE_TYPE_FALLBACK[0] : 'g6e.4xlarge');

    // --- 리소스 Name 태그 접두사 (스택 이름과 동일 패턴) ---
    const profilePart = props.versionProfile.charAt(0).toUpperCase() + props.versionProfile.slice(1);
    const accountSuffix = accountId ? `-${accountId}` : '';
    const namePrefix = `IsaacLab-${profilePart}${accountSuffix}`;


    // --- 스택 레벨 태그 (모든 리소스에 자동 전파) ---
    cdk.Tags.of(this).add('Project', 'IsaacLab');
    cdk.Tags.of(this).add('Environment', props.versionProfile);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    if (accountId) {
      // HyperPod 스택의 createVpc=false 경로가 tag:UserId로 이 VPC를 찾는다.
      // 1인 1계정 전제이므로 값은 항상 계정 ID다.
      cdk.Tags.of(this).add('UserId', accountId);
    }

    // --- 버전 프로필 조회 ---
    const baseProfile = VERSION_PROFILES[props.versionProfile];
    // isaacSimVersion 오버라이드: context로 지정 시 프로필 기본값 대신 사용
    // 프로필의 isaacLabVersion은 해당 Isaac Sim 버전에만 대응하므로 함께 해제한다
    // (빈 값이면 isaac-lab.sh가 IsaacLab main을 클론). 버전 조합을 맞추려면
    // isaacSimVersion 오버라이드 대신 versionProfile을 사용할 것.
    const versionProfileConfig = props.isaacSimVersion
      ? {
          ...baseProfile,
          isaacSimVersion: props.isaacSimVersion,
          isaacSimDockerImage: `nvcr.io/nvidia/isaac-sim:${props.isaacSimVersion}`,
          isaacLabVersion: undefined,
        }
      : baseProfile;

    // --- AMI 매핑을 CfnMapping으로 변환 ---
    // DCV AMI 매핑: DCV_AMI_MAPPING은 이미 Record<string, Record<string, string>> 형식
    const dcvAmiMapping = new cdk.CfnMapping(this, 'DcvAmiMapping', {
      mapping: DCV_AMI_MAPPING,
    });

    // AMI ID 조회 (CloudFormation FindInMap — 배포 시점에 리전 결정)
    const dcvAmiId = dcvAmiMapping.findInMap(cdk.Aws.REGION, versionProfileConfig.ubuntuVersion);

    // --- AZ 자동 탐색 (preferredAZ === 'auto'일 때) ---
    // Custom Resource Lambda로 실제 GPU capacity가 있는 AZ를 탐색한다.
    // inferenceInstanceType이 지정되면 해당 타입만 시도.
    // 미지정(기본값)이면 fallback 리스트를 순차 시도.
    // preferredAZ가 인덱스('0'~'5')이면 Lambda 탐색을 건너뛰고 해당 인덱스의 AZ를 직접 사용.
    let resolvedAZ: string | undefined;
    let resolvedInstanceType: string = instanceType;
    if (preferredAZ === 'auto') {
      // 인스턴스 타입이 명시적으로 지정되었으면 해당 타입만, 아니면 프로필별 fallback 리스트 사용
      const instanceTypes = props.inferenceInstanceType
        ? [props.inferenceInstanceType]
        : cpuWorkstation
          ? CPU_INSTANCE_TYPE_FALLBACK
          : DEFAULT_INSTANCE_TYPE_FALLBACK;

      const azSelector = new AzSelectorConstruct(this, 'AzSelector', {
        instanceTypes,
        amiId: dcvAmiId,
      });
      resolvedAZ = azSelector.availabilityZone;
      resolvedInstanceType = azSelector.resolvedInstanceType;
    }

    // --- [1/3] NetworkingConstruct ---
    // VPC, 서브넷, IGW, NAT, S3 Endpoint, Flow Log, DCV SG
    const enableCodeServer = props.enableCodeServer ?? true;

    const networking = new NetworkingConstruct(this, 'Networking', {
      namePrefix,
      preferredAZ,
      allowedCidr,
      resolvedAZ,
      vpcCidr: props.vpcCidr,
      enableCodeServer,
    });

    // --- [2/3] FsxStorageConstruct ---
    // 공유 FSx for Lustre — DCV(/fsx 마운트), SageMaker Training(groot 스택 DRA),
    // HyperPod(-c fsxFileSystemId import)이 모두 이 파일시스템을 공유한다.
    const fsxStorage = new FsxStorageConstruct(this, 'FsxStorage', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnet: networking.privateSubnet,
      vpcCidr: props.vpcCidr,
      capacityGiB: props.fsxCapacityGiB,
    });

    // --- [3/3] DcvInstanceConstruct ---
    // DCV EC2 인스턴스 (Networking, FSx 의존)
    const dcvInstance = new DcvInstanceConstruct(this, 'DcvInstance', {
      namePrefix,
      vpc: networking.vpc,
      publicSubnet: networking.publicSubnet,
      dcvSecurityGroup: networking.dcvSecurityGroup,
      fsxFileSystem: fsxStorage.fileSystem,
      instanceType: resolvedInstanceType,
      versionProfile: versionProfileConfig,
      versionProfileName: props.versionProfile,
      amiId: dcvAmiId,
      enableCloudWatch: props.enableCloudWatch,
      enableCodeServer,
      grootWeightsUrl: props.grootWeightsUrl,
      modelsDir: props.modelsDir,
      workstationMode: cpuWorkstation ? 'cpu' : 'gpu',
    });

    // --- [3.5] CloudFrontCodeServerConstruct (code-server 활성화 시만 생성) ---
    let codeServerCdn: CloudFrontCodeServerConstruct | undefined;
    if (enableCodeServer) {
      codeServerCdn = new CloudFrontCodeServerConstruct(this, 'CodeServerCdn', {
        instance: dcvInstance.instance,
        namePrefix,
      });
    }

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

    new cdk.CfnOutput(this, 'DeploymentProfile', {
      value: profile,
      description: 'Deployment profile (personal | workshop-studio)',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: networking.vpc.ref,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'PrivateSubnetId', {
      value: networking.privateSubnet.ref,
      description: 'Private Subnet ID',
    });

    new cdk.CfnOutput(this, 'FsxFileSystemId', {
      value: fsxStorage.fileSystem.ref,
      description: 'Shared FSx for Lustre File System ID',
    });

    new cdk.CfnOutput(this, 'FsxMountName', {
      value: fsxStorage.fileSystem.attrLustreMountName,
      description: 'Shared FSx for Lustre mount name',
    });

    new cdk.CfnOutput(this, 'FsxSecurityGroupId', {
      value: fsxStorage.securityGroup.ref,
      description: 'FSx Security Group ID (Lustre access)',
    });

    if (accountId) {
      new cdk.CfnOutput(this, 'UserId', {
        value: accountId,
        description: 'Deployment identifier (AWS account ID)',
      });
    }
  }
}
