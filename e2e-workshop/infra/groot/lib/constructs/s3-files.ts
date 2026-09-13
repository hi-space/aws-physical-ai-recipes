/**
 * S3FilesMount
 *
 * 아티팩트 버킷을 Amazon S3 Files 파일시스템으로 노출한다. DCV 인스턴스가 이 파일시스템을
 * NFS(s3files 마운트 헬퍼)로 마운트하면 SageMaker 학습 잡이 S3로 export한 체크포인트가
 * `aws s3 sync` 없이 `/mnt/s3/groot/models/groot-sm/<execution-id>/` 로 바로 보인다.
 *
 * 구성 요소:
 *   - S3 Files 서비스가 assume하는 IAM 역할 (버킷 동기화 + EventBridge 규칙 관리)
 *   - AWS::S3Files::FileSystem (버킷 전체 스코프, 버전 관리·SSE-S3 버킷 필수)
 *   - 마운트 타깃 보안 그룹 (NFS 2049, VPC CIDR 인바운드)
 *   - AWS::S3Files::MountTarget (부모 IsaacLab 스택의 프라이빗 서브넷. 퍼블릭 서브넷의
 *     DCV 인스턴스와 같은 AZ 이므로 EC2 마운트 조건을 만족한다)
 *
 * 동작 특성 (문서: s3-files-performance / s3-files-best-practices):
 *   - 128KiB 미만 파일만 고성능 계층에 캐시되고, 1MiB 이상 읽기는 S3에서 직접 스트리밍한다.
 *   - 파일시스템에서 쓴 내용은 약 60초 배칭 후 S3에 반영된다.
 *   - S3 와 파일시스템에서 같은 파일을 동시에 수정하면 S3 가 진실이고 파일은 lost+found 로 간다.
 *     학습 잡(S3 writer)과 DCV(reader)를 분리하는 현재 흐름에서는 문제 없다.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3files from 'aws-cdk-lib/aws-s3files';
import { Construct } from 'constructs';

export interface S3FilesMountProps {
  /** 파일시스템으로 노출할 버킷 (버전 관리 + SSE-S3/SSE-KMS 필수). */
  bucket: s3.IBucket;
  /** 마운트 타깃을 둘 VPC (부모 IsaacLab 스택). */
  vpcId: string;
  /** 마운트 타깃 서브넷 (부모 IsaacLab 스택의 프라이빗 서브넷, DCV 와 같은 AZ). */
  subnetId: string;
  /** NFS 2049 인바운드를 허용할 CIDR (VPC CIDR). 기본 10.0.0.0/16. */
  vpcCidr?: string;
  /** S3 Files 서비스 역할 이름 (계정 글로벌 네임스페이스 — 리전 포함 권장). */
  roleName: string;
  /** 리소스 Name 태그. */
  nameTag: string;
}

export class S3FilesMount extends Construct {
  public readonly fileSystem: s3files.CfnFileSystem;
  public readonly mountTarget: s3files.CfnMountTarget;
  public readonly securityGroup: ec2.CfnSecurityGroup;
  public readonly serviceRole: iam.Role;

  constructor(scope: Construct, id: string, props: S3FilesMountProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';

    // ---------- [1] S3 Files 서비스 역할 ----------
    // 문서(s3-files-prereq-policies)의 정책을 그대로 따른다. 버전별 API(GetObjectVersion 등)를
    // 쓰므로 와일드카드(GetObject*)로 준다. EventBridge 규칙은 서비스가 만들고 관리하는
    // `DO-NOT-DELETE-S3-Files*` 규칙 — 삭제하면 파일시스템이 S3 변경을 감지하지 못한다.
    this.serviceRole = new iam.Role(this, 'ServiceRole', {
      roleName: props.roleName,
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:s3files:${stack.region}:${stack.account}:file-system/*` },
        },
      }),
      inlinePolicies: {
        S3FilesSync: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'S3BucketPermissions',
              actions: ['s3:ListBucket', 's3:ListBucketVersions'],
              resources: [props.bucket.bucketArn],
              conditions: { StringEquals: { 'aws:ResourceAccount': stack.account } },
            }),
            new iam.PolicyStatement({
              sid: 'S3ObjectPermissions',
              actions: ['s3:AbortMultipartUpload', 's3:DeleteObject*', 's3:GetObject*', 's3:List*', 's3:PutObject*'],
              resources: [props.bucket.arnForObjects('*')],
              conditions: { StringEquals: { 'aws:ResourceAccount': stack.account } },
            }),
            new iam.PolicyStatement({
              sid: 'EventBridgeManage',
              actions: [
                'events:DeleteRule',
                'events:DisableRule',
                'events:EnableRule',
                'events:PutRule',
                'events:PutTargets',
                'events:RemoveTargets',
              ],
              resources: ['arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*'],
              conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
            }),
            new iam.PolicyStatement({
              sid: 'EventBridgeRead',
              actions: ['events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule'],
              resources: ['arn:aws:events:*:*:rule/*'],
            }),
          ],
        }),
      },
    });

    // ---------- [2] 파일시스템 ----------
    // prefix 를 비워 버킷 전체를 노출한다. models/ (export), checkpoints/ (재개용),
    // pipeline 입력 등을 한 마운트에서 볼 수 있다. acceptBucketWarning 은 이미 객체가 있는
    // 버킷 등 서비스가 내는 구성 경고를 승인하는 플래그로, 없으면 생성이 거부될 수 있다.
    this.fileSystem = new s3files.CfnFileSystem(this, 'FileSystem', {
      bucket: props.bucket.bucketArn,
      roleArn: this.serviceRole.roleArn,
      acceptBucketWarning: true,
      tags: [{ key: 'Name', value: props.nameTag }],
    });
    this.fileSystem.node.addDependency(this.serviceRole);

    // ---------- [3] 마운트 타깃 SG + 마운트 타깃 ----------
    // VPC CIDR 전체에서 2049 를 열어 두면 같은 VPC 에 나중에 합류하는 노드도 SG 수정 없이 마운트한다.
    this.securityGroup = new ec2.CfnSecurityGroup(this, 'MountTargetSg', {
      groupDescription: 'S3 Files mount target - NFS 2049 from VPC',
      vpcId: props.vpcId,
      securityGroupIngress: [
        { ipProtocol: 'tcp', fromPort: 2049, toPort: 2049, cidrIp: vpcCidr, description: 'NFS from VPC CIDR' },
      ],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'Allow all outbound traffic' }],
      tags: [{ key: 'Name', value: `${props.nameTag}-mt-sg` }],
    });

    this.mountTarget = new s3files.CfnMountTarget(this, 'MountTarget', {
      fileSystemId: this.fileSystem.attrFileSystemId,
      subnetId: props.subnetId,
      securityGroups: [this.securityGroup.ref],
    });
  }
}
