# HyperPod 로봇 모델 학습 인프라 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SageMaker HyperPod 기반 VLA/RL 로봇 모델 학습 인프라를 CDK로 구축하고, 리서처가 바로 사용할 수 있는 SLURM 템플릿 + 예시 코드 + 가이드 문서를 제공한다.

**Architecture:** 단일 HyperPod 클러스터(4 파티션: head/sim/train/debug)를 AWS CDK TypeScript L1 construct로 프로비저닝한다. FSx for Lustre ↔ S3 자동 동기화로 데이터 접근을 가속화하고, SageMaker Managed MLflow로 실험을 추적한다. 멀티유저 격리는 CDK context `userId`로 VPC + 클러스터 + 스토리지 전체를 분리한다.

**Tech Stack:** AWS CDK (TypeScript), SageMaker HyperPod (CfnCluster), FSx for Lustre, S3, SageMaker MLflow, SLURM, Enroot+Pyxis, Ray, IsaacLab, PyTorch DDP

**Spec:** `training/docs/superpowers/specs/2026-05-02-hyperpod-training-infra-design.md`

**Validation:** `cdk synth`로 CloudFormation 템플릿 생성 확인 (인프라 코드이므로 단위 테스트 대신 synth 검증)

---

## File Structure

```
training/hyperpod/
├── cdk/
│   ├── bin/app.ts                        # CDK App entrypoint
│   ├── lib/
│   │   ├── hyperpod-stack.ts             # 메인 스택 (construct 조합)
│   │   ├── constructs/
│   │   │   ├── networking.ts             # VPC, Subnets, NAT, VPC Endpoints
│   │   │   ├── storage.ts               # S3 + FSx for Lustre
│   │   │   ├── hyperpod-cluster.ts      # SageMaker HyperPod CfnCluster
│   │   │   └── mlflow.ts               # SageMaker MLflow Tracking Server
│   │   └── config/
│   │       └── cluster-config.ts         # 인스턴스 그룹/파티션 기본값
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
│
├── lifecycle-scripts/
│   ├── on_create.sh                      # 노드 초기화 (Enroot, Pyxis, NVIDIA 드라이버)
│   ├── setup_slurm.sh                    # SLURM 파티션 + 오토스케일링 설정
│   └── setup_fsx.sh                      # FSx 마운트
│
├── cluster-config/
│   ├── cluster-config.json               # 수동 배포용 HyperPod 클러스터 설정
│   ├── provisioning-params.json          # lifecycle script 파라미터
│   └── manual-setup.md                   # CLI 수동 생성 가이드
│
├── slurm-templates/
│   ├── rl/
│   │   ├── actor.sbatch                  # IsaacLab headless Actor
│   │   ├── learner.sbatch               # RL Learner (Ray head)
│   │   └── run_rl.sh                    # Actor-Learner 동시 제출
│   ├── vla/
│   │   ├── finetune_groot.sbatch        # GR00T SFT
│   │   ├── finetune_pi0.sbatch          # π0 fine-tuning
│   │   └── run_vla.sh                   # VLA 학습 실행 래퍼
│   └── debug/
│       └── dcv_session.sbatch           # DCV 시각화 세션
│
├── examples/
│   ├── vla/
│   │   ├── train_groot.py               # GR00T fine-tuning 최소 예시
│   │   ├── train_pi0.py                 # π0 fine-tuning 최소 예시
│   │   └── verify_in_sim.py            # Isaac Sim 검증
│   ├── rl/
│   │   ├── train_isaaclab.py            # IsaacLab RL (Actor-Learner)
│   │   └── ray_config.yaml             # Ray on SLURM 설정
│   └── mlflow/
│       └── example_tracking.py          # MLflow 기록 예시
│
├── mlflow/
│   ├── setup.sh                          # SageMaker MLflow 초기 설정 확인
│   └── example_usage.py                  # 리서처용 MLflow 사용 예시
│
└── docs/
    ├── researcher_guide.md              # 리서처 가이드
    └── architecture.md                  # 아키텍처 설명
```

---

## Task 1: CDK 프로젝트 스캐폴딩

**Files:**
- Create: `training/hyperpod/cdk/package.json`
- Create: `training/hyperpod/cdk/tsconfig.json`
- Create: `training/hyperpod/cdk/cdk.json`
- Create: `training/hyperpod/cdk/bin/app.ts`
- Create: `training/hyperpod/cdk/lib/config/cluster-config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "hyperpod-training-infra",
  "version": "1.0.0",
  "description": "SageMaker HyperPod 기반 로봇 모델 학습 인프라 CDK 프로젝트",
  "scripts": {
    "cdk": "cdk",
    "build": "tsc",
    "synth": "cdk synth"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.180.0",
    "constructs": "^10.4.2"
  },
  "devDependencies": {
    "aws-cdk": "^2.180.0",
    "ts-node": "^10.9.2",
    "typescript": "~5.7.3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["es2020"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": false,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "strictPropertyInitialization": false,
    "outDir": "./cdk.out",
    "rootDir": "."
  },
  "exclude": ["node_modules", "cdk.out"]
}
```

- [ ] **Step 3: Create cdk.json**

```json
{
  "app": "npx ts-node bin/app.ts",
  "watch": {
    "include": ["**"],
    "exclude": [
      "README.md",
      "cdk*.json",
      "**/*.d.ts",
      "**/*.js",
      "tsconfig.json",
      "package*.json",
      "node_modules",
      "cdk.out"
    ]
  },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/core:target-partitions": ["aws", "aws-cn"]
  }
}
```

- [ ] **Step 4: Create config/cluster-config.ts**

```typescript
export interface InstanceGroupConfig {
  name: string;
  instanceType: string;
  instanceCount: number;
  maxCount: number;
  useSpot: boolean;
}

export interface ClusterDefaults {
  head: InstanceGroupConfig;
  sim: InstanceGroupConfig;
  train: InstanceGroupConfig;
  debug: InstanceGroupConfig;
}

/**
 * Train 인스턴스 타입 프리셋
 *
 * | 프리셋  | 인스턴스           | GPU             | 적합한 작업                    |
 * |---------|-------------------|-----------------|-------------------------------|
 * | default | ml.g6e.12xlarge   | 4× L40S (48GB)  | GR00T-3B LoRA/Full SFT        |
 * | heavy   | ml.p4d.24xlarge   | 8× A100 (40GB)  | 대규모 VLA, 멀티노드            |
 * | max     | ml.p5.48xlarge    | 8× H100 (80GB)  | 큰 모델 full fine-tuning       |
 */
export const TRAIN_INSTANCE_PRESETS: Record<string, string> = {
  default: 'ml.g6e.12xlarge',
  heavy: 'ml.p4d.24xlarge',
  max: 'ml.p5.48xlarge',
};

export const DEFAULT_CLUSTER_CONFIG: ClusterDefaults = {
  head: {
    name: 'head',
    instanceType: 'ml.m5.xlarge',
    instanceCount: 1,
    maxCount: 1,
    useSpot: false,
  },
  sim: {
    name: 'sim',
    instanceType: 'ml.g5.12xlarge',
    instanceCount: 0,
    maxCount: 16,
    useSpot: true,
  },
  train: {
    name: 'train',
    instanceType: 'ml.g6e.12xlarge',
    instanceCount: 0,
    maxCount: 4,
    useSpot: false,
  },
  debug: {
    name: 'debug',
    instanceType: 'ml.g5.4xlarge',
    instanceCount: 0,
    maxCount: 1,
    useSpot: false,
  },
};
```

- [ ] **Step 5: Create bin/app.ts**

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HyperPodStack } from '../lib/hyperpod-stack';
import { TRAIN_INSTANCE_PRESETS } from '../lib/config/cluster-config';

const app = new cdk.App();

const userId = app.node.tryGetContext('userId') ?? '';
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const createVpc = (app.node.tryGetContext('createVpc') ?? 'true') === 'true';
const simMaxCount = parseInt(app.node.tryGetContext('simMaxCount') ?? '16', 10);
const trainMaxCount = parseInt(app.node.tryGetContext('trainMaxCount') ?? '4', 10);
const simInstanceType = app.node.tryGetContext('simInstanceType') ?? 'ml.g5.12xlarge';
const trainPreset = app.node.tryGetContext('trainPreset') ?? 'default';  // default | heavy | max
const trainInstanceType = app.node.tryGetContext('trainInstanceType')
  ?? TRAIN_INSTANCE_PRESETS[trainPreset]
  ?? 'ml.g6e.12xlarge';
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
const simUseSpot = (app.node.tryGetContext('simUseSpot') ?? 'true') === 'true';
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';

if (userId && !/^[a-z0-9-]+$/.test(userId)) {
  throw new Error(`userId는 영문소문자, 숫자, 하이픈만 허용됩니다: '${userId}'`);
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const userSuffix = userId ? `-${userId}` : '';
const stackName = `HyperPod${userSuffix}`;

new HyperPodStack(app, stackName, {
  env,
  userId,
  createVpc,
  vpcCidr,
  simMaxCount,
  trainMaxCount,
  simInstanceType,
  trainInstanceType,
  fsxCapacityGiB,
  simUseSpot,
});
```

- [ ] **Step 6: Install dependencies and verify**

```bash
cd training/hyperpod/cdk && npm install
```

- [ ] **Step 7: Commit**

```bash
git add training/hyperpod/cdk/package.json training/hyperpod/cdk/tsconfig.json \
  training/hyperpod/cdk/cdk.json training/hyperpod/cdk/bin/app.ts \
  training/hyperpod/cdk/lib/config/cluster-config.ts
git commit -m "feat(hyperpod): CDK 프로젝트 스캐폴딩"
```

---

## Task 2: Networking Construct

**Files:**
- Create: `training/hyperpod/cdk/lib/constructs/networking.ts`

- [ ] **Step 1: Create networking.ts**

기존 `infra-multiuser-groot`의 NetworkingConstruct 패턴을 따르되, HyperPod에 필요한 VPC Endpoint (SageMaker API, SageMaker Runtime) 추가:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkingProps {
  namePrefix: string;
  vpcCidr?: string;
  /** false이면 UserId 태그로 기존 VPC를 자동 탐색 */
  createVpc?: boolean;
  /** 기존 VPC 탐색 시 사용할 UserId 태그 값 */
  userId?: string;
}

export class NetworkingConstruct extends Construct {
  public readonly vpc: ec2.CfnVPC;
  public readonly publicSubnet: ec2.CfnSubnet;
  public readonly privateSubnet: ec2.CfnSubnet;
  public readonly privateRouteTable: ec2.CfnRouteTable;
  /** 기존 VPC 사용 시 조회된 VPC ID */
  public readonly vpcId: string;
  /** 기존 VPC 사용 시 조회된 Private Subnet ID */
  public readonly privateSubnetId: string;

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);

    const createVpc = props.createVpc ?? true;
    const p = props.namePrefix;

    // --- 기존 VPC 자동 탐색 모드 ---
    if (!createVpc) {
      const vpcLookup = new cr.AwsCustomResource(this, 'VpcLookup', {
        onCreate: {
          service: 'EC2',
          action: 'describeVpcs',
          parameters: {
            Filters: [{ Name: 'tag:UserId', Values: [props.userId ?? ''] }],
          },
          physicalResourceId: cr.PhysicalResourceId.of('vpc-lookup'),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
      this.vpcId = vpcLookup.getResponseField('Vpcs.0.VpcId');

      const subnetLookup = new cr.AwsCustomResource(this, 'SubnetLookup', {
        onCreate: {
          service: 'EC2',
          action: 'describeSubnets',
          parameters: {
            Filters: [
              { Name: 'vpc-id', Values: [this.vpcId] },
              { Name: 'tag:Name', Values: ['*Private*'] },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of('subnet-lookup'),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
      this.privateSubnetId = subnetLookup.getResponseField('Subnets.0.SubnetId');

      // CfnVPC/CfnSubnet 참조는 사용하지 않지만 인터페이스 호환을 위해 null 할당
      // 실제 구현에서는 Fn.importValue 또는 별도 인터페이스로 처리
      this.vpc = undefined as any;
      this.publicSubnet = undefined as any;
      this.privateSubnet = undefined as any;
      this.privateRouteTable = undefined as any;
      return;
    }

    // --- 새 VPC 생성 모드 ---
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';
    const cidrPrefix = vpcCidr.split('.').slice(0, 2).join('.');
    const publicSubnetCidr = `${cidrPrefix}.0.0/24`;
    const privateSubnetCidr = `${cidrPrefix}.1.0/24`;

    // VPC
    this.vpc = new ec2.CfnVPC(this, 'VPC', {
      cidrBlock: vpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${p}-VPC` }],
    });

    // Internet Gateway
    const igw = new ec2.CfnInternetGateway(this, 'IGW', {
      tags: [{ key: 'Name', value: `${p}-IGW` }],
    });
    const vpcGwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VPCGwAttach', {
      vpcId: this.vpc.ref,
      internetGatewayId: igw.ref,
    });

    // Public Subnet
    this.publicSubnet = new ec2.CfnSubnet(this, 'PublicSubnet', {
      vpcId: this.vpc.ref,
      cidrBlock: publicSubnetCidr,
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs('')),
      mapPublicIpOnLaunch: true,
      tags: [{ key: 'Name', value: `${p}-Public` }],
    });

    const publicRT = new ec2.CfnRouteTable(this, 'PublicRT', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Public-RT` }],
    });
    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: publicRT.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });
    (publicRoute as cdk.CfnResource).addDependency(vpcGwAttachment);
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicRTAssoc', {
      subnetId: this.publicSubnet.ref,
      routeTableId: publicRT.ref,
    });

    // Private Subnet
    this.privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: this.vpc.ref,
      cidrBlock: privateSubnetCidr,
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs('')),
      tags: [{ key: 'Name', value: `${p}-Private` }],
    });

    const natEip = new ec2.CfnEIP(this, 'NatEIP', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${p}-NAT-EIP` }],
    });
    const natGw = new ec2.CfnNatGateway(this, 'NatGW', {
      subnetId: this.publicSubnet.ref,
      allocationId: natEip.attrAllocationId,
      tags: [{ key: 'Name', value: `${p}-NAT-GW` }],
    });

    this.privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRT', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Private-RT` }],
    });
    new ec2.CfnRoute(this, 'PrivateRoute', {
      routeTableId: this.privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: natGw.ref,
    });
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateRTAssoc', {
      subnetId: this.privateSubnet.ref,
      routeTableId: this.privateRouteTable.ref,
    });

    // S3 Gateway Endpoint
    new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {
      vpcId: this.vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [this.privateRouteTable.ref],
    });

    // SageMaker API Interface Endpoint (MLflow 접근용)
    new ec2.CfnVPCEndpoint(this, 'SageMakerApiEndpoint', {
      vpcId: this.vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.sagemaker.api`,
      vpcEndpointType: 'Interface',
      subnetIds: [this.privateSubnet.ref],
      privateDnsEnabled: true,
    });

    // VPC Flow Log
    const logGroup = new logs.CfnLogGroup(this, 'FlowLogGroup', {
      retentionInDays: 7,
      tags: [{ key: 'Name', value: `${p}-FlowLog` }],
    });
    const flowLogRole = new iam.CfnRole(this, 'FlowLogRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      policies: [{
        policyName: 'FlowLogPolicy',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: '*',
          }],
        },
      }],
    });
    new ec2.CfnFlowLog(this, 'FlowLog', {
      resourceId: this.vpc.ref,
      resourceType: 'VPC',
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logGroupName: logGroup.ref,
      deliverLogsPermissionArn: flowLogRole.attrArn,
    });
  }
}
```

- [ ] **Step 2: Verify synth compiles (after stack stub in Task 6)**

```bash
cd training/hyperpod/cdk && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/cdk/lib/constructs/networking.ts
git commit -m "feat(hyperpod): Networking construct (VPC, subnets, endpoints)"
```

---

## Task 3: Storage Construct

**Files:**
- Create: `training/hyperpod/cdk/lib/constructs/storage.ts`

- [ ] **Step 1: Create storage.ts**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface StorageProps {
  namePrefix: string;
  vpc: ec2.CfnVPC;
  privateSubnet: ec2.CfnSubnet;
  fsxCapacityGiB: number;
}

export class StorageConstruct extends Construct {
  public readonly bucket: s3.CfnBucket;
  public readonly fileSystem: fsx.CfnFileSystem;
  public readonly fsxMountName: string;
  public readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const p = props.namePrefix;

    // S3 Bucket
    this.bucket = new s3.CfnBucket(this, 'DataBucket', {
      bucketName: cdk.Fn.join('-', [
        'hyperpod-data',
        p.toLowerCase(),
        cdk.Aws.ACCOUNT_ID,
        cdk.Aws.REGION,
      ]),
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [{
          id: 'TransitionToIA',
          status: 'Enabled',
          transitions: [{
            storageClass: 'INTELLIGENT_TIERING',
            transitionInDays: 30,
          }],
        }],
      },
      tags: [{ key: 'Name', value: `${p}-Data` }],
    });

    // FSx Security Group
    this.securityGroup = new ec2.CfnSecurityGroup(this, 'FsxSG', {
      groupDescription: 'FSx for Lustre security group',
      vpcId: props.vpc.ref,
      securityGroupIngress: [{
        ipProtocol: 'tcp',
        fromPort: 988,
        toPort: 988,
        cidrIp: '10.0.0.0/16',
        description: 'Lustre',
      }, {
        ipProtocol: 'tcp',
        fromPort: 1021,
        toPort: 1023,
        cidrIp: '10.0.0.0/16',
        description: 'Lustre',
      }],
      securityGroupEgress: [{
        ipProtocol: '-1',
        cidrIp: '0.0.0.0/0',
      }],
      tags: [{ key: 'Name', value: `${p}-FSx-SG` }],
    });

    // FSx for Lustre
    this.fileSystem = new fsx.CfnFileSystem(this, 'LustreFS', {
      fileSystemType: 'LUSTRE',
      storageCapacity: props.fsxCapacityGiB,
      subnetIds: [props.privateSubnet.ref],
      securityGroupIds: [this.securityGroup.ref],
      lustreConfiguration: {
        deploymentType: 'PERSISTENT_2',
        perUnitStorageThroughput: 125,
        dataCompressionType: 'LZ4',
        importPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/datasets']),
        exportPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/checkpoints']),
        autoImportPolicy: 'NEW_CHANGED_DELETED',
      },
      tags: [{ key: 'Name', value: `${p}-FSx` }],
    });

    this.fsxMountName = cdk.Fn.getAtt(this.fileSystem.logicalId, 'LustreMountName').toString();
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd training/hyperpod/cdk && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/cdk/lib/constructs/storage.ts
git commit -m "feat(hyperpod): Storage construct (S3 + FSx for Lustre)"
```

---

## Task 4: HyperPod Cluster Construct

**Files:**
- Create: `training/hyperpod/cdk/lib/constructs/hyperpod-cluster.ts`

- [ ] **Step 1: Create hyperpod-cluster.ts**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InstanceGroupConfig } from '../config/cluster-config';

export interface HyperPodClusterProps {
  namePrefix: string;
  vpc: ec2.CfnVPC;
  privateSubnet: ec2.CfnSubnet;
  fsxSecurityGroup: ec2.CfnSecurityGroup;
  dataBucket: s3.CfnBucket;
  head: InstanceGroupConfig;
  sim: InstanceGroupConfig;
  train: InstanceGroupConfig;
  debug: InstanceGroupConfig;
}

export class HyperPodClusterConstruct extends Construct {
  public readonly clusterArn: string;
  public readonly clusterName: string;
  public readonly executionRole: iam.CfnRole;

  constructor(scope: Construct, id: string, props: HyperPodClusterProps) {
    super(scope, id);

    const p = props.namePrefix;

    // HyperPod Execution Role
    this.executionRole = new iam.CfnRole(this, 'ExecutionRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'sagemaker.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy',
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
        'arn:aws:iam::aws:policy/AmazonFSxFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      ],
      tags: [{ key: 'Name', value: `${p}-HyperPod-Role` }],
    });

    // Lifecycle Script S3 Bucket (CDK로 lifecycle scripts 업로드)
    const lifecycleBucket = new s3.CfnBucket(this, 'LifecycleBucket', {
      bucketName: cdk.Fn.join('-', [
        'hyperpod-lifecycle',
        p.toLowerCase(),
        cdk.Aws.ACCOUNT_ID,
        cdk.Aws.REGION,
      ]),
      tags: [{ key: 'Name', value: `${p}-Lifecycle` }],
    });

    // Cluster Security Group
    const clusterSG = new ec2.CfnSecurityGroup(this, 'ClusterSG', {
      groupDescription: 'HyperPod cluster internal communication',
      vpcId: props.vpc.ref,
      securityGroupEgress: [{
        ipProtocol: '-1',
        cidrIp: '0.0.0.0/0',
      }],
      tags: [{ key: 'Name', value: `${p}-Cluster-SG` }],
    });

    // Self-referencing ingress for inter-node communication
    new ec2.CfnSecurityGroupIngress(this, 'ClusterSelfIngress', {
      groupId: clusterSG.ref,
      ipProtocol: '-1',
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Inter-node communication (NCCL, Ray, SLURM)',
    });

    // Allow cluster nodes to access FSx
    new ec2.CfnSecurityGroupIngress(this, 'FsxFromCluster', {
      groupId: props.fsxSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 988,
      toPort: 988,
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Lustre from HyperPod',
    });
    new ec2.CfnSecurityGroupIngress(this, 'FsxFromCluster2', {
      groupId: props.fsxSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 1021,
      toPort: 1023,
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Lustre from HyperPod',
    });

    // HyperPod Cluster (AWS::SageMaker::Cluster)
    const buildInstanceGroup = (config: InstanceGroupConfig) => ({
      InstanceGroupName: config.name,
      InstanceType: config.instanceType,
      InstanceCount: config.maxCount,
      LifeCycleConfig: {
        SourceS3Uri: cdk.Fn.join('', ['s3://', lifecycleBucket.ref, '/lifecycle-scripts/']),
        OnCreate: 'on_create.sh',
      },
      ExecutionRole: this.executionRole.attrArn,
    });

    const cluster = new cdk.CfnResource(this, 'Cluster', {
      type: 'AWS::SageMaker::Cluster',
      properties: {
        ClusterName: p.toLowerCase(),
        InstanceGroups: [
          buildInstanceGroup(props.head),
          buildInstanceGroup(props.sim),
          buildInstanceGroup(props.train),
          buildInstanceGroup(props.debug),
        ],
        VpcConfig: {
          SecurityGroupIds: [clusterSG.ref],
          Subnets: [props.privateSubnet.ref],
        },
      },
    });

    this.clusterArn = cluster.getAtt('ClusterArn').toString();
    this.clusterName = p.toLowerCase();

    // Outputs
    new cdk.CfnOutput(this, 'ClusterNameOutput', {
      value: p.toLowerCase(),
      description: 'HyperPod Cluster Name',
    });
    new cdk.CfnOutput(this, 'LifecycleBucketOutput', {
      value: lifecycleBucket.ref,
      description: 'Lifecycle Scripts S3 Bucket',
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd training/hyperpod/cdk && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/cdk/lib/constructs/hyperpod-cluster.ts
git commit -m "feat(hyperpod): HyperPod cluster construct (CfnResource)"
```

---

## Task 5: MLflow Construct

**Files:**
- Create: `training/hyperpod/cdk/lib/constructs/mlflow.ts`

- [ ] **Step 1: Create mlflow.ts**

```typescript
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

    // MLflow Execution Role
    const mlflowRole = new iam.CfnRole(this, 'MlflowRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'sagemaker.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
        'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess',
      ],
      tags: [{ key: 'Name', value: `${p}-MLflow-Role` }],
    });

    // SageMaker MLflow Tracking Server
    const trackingServer = new cdk.CfnResource(this, 'TrackingServer', {
      type: 'AWS::SageMaker::MlflowTrackingServer',
      properties: {
        TrackingServerName: `${p}-mlflow`.toLowerCase(),
        ArtifactStoreUri: cdk.Fn.join('', ['s3://', props.artifactBucket.ref, '/mlflow-artifacts']),
        TrackingServerSize: 'Small',
        RoleArn: mlflowRole.attrArn,
        AutomaticModelRegistration: false,
      },
    });

    this.trackingServerArn = trackingServer.getAtt('TrackingServerArn').toString();
    this.trackingUri = cdk.Fn.join('', [
      'https://',
      cdk.Aws.REGION,
      '.experiments.sagemaker.aws/mlflow/',
      `${p}-mlflow`.toLowerCase(),
    ]);

    new cdk.CfnOutput(this, 'MlflowTrackingUri', {
      value: this.trackingUri,
      description: 'SageMaker MLflow Tracking URI',
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd training/hyperpod/cdk && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/cdk/lib/constructs/mlflow.ts
git commit -m "feat(hyperpod): SageMaker MLflow tracking server construct"
```

---

## Task 6: Main Stack (Compose All Constructs)

**Files:**
- Create: `training/hyperpod/cdk/lib/hyperpod-stack.ts`

- [ ] **Step 1: Create hyperpod-stack.ts**

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NetworkingConstruct } from './constructs/networking';
import { StorageConstruct } from './constructs/storage';
import { HyperPodClusterConstruct } from './constructs/hyperpod-cluster';
import { MlflowConstruct } from './constructs/mlflow';
import { DEFAULT_CLUSTER_CONFIG } from './config/cluster-config';

export interface HyperPodStackProps extends cdk.StackProps {
  userId: string;
  createVpc: boolean;
  vpcCidr: string;
  simMaxCount: number;
  trainMaxCount: number;
  simInstanceType: string;
  trainInstanceType: string;
  fsxCapacityGiB: number;
  simUseSpot: boolean;
}

export class HyperPodStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HyperPodStackProps) {
    super(scope, id, props);

    const userId = props.userId;
    const userSuffix = userId ? `-${userId}` : '';
    const namePrefix = `HyperPod${userSuffix}`;

    if (userId) {
      cdk.Tags.of(this).add('UserId', userId);
    }

    // Override cluster config with context values
    const clusterConfig = {
      head: { ...DEFAULT_CLUSTER_CONFIG.head },
      sim: {
        ...DEFAULT_CLUSTER_CONFIG.sim,
        instanceType: props.simInstanceType,
        maxCount: props.simMaxCount,
        useSpot: props.simUseSpot,
      },
      train: {
        ...DEFAULT_CLUSTER_CONFIG.train,
        instanceType: props.trainInstanceType,
        maxCount: props.trainMaxCount,
      },
      debug: { ...DEFAULT_CLUSTER_CONFIG.debug },
    };

    // 1. Networking
    const networking = new NetworkingConstruct(this, 'Networking', {
      namePrefix,
      createVpc: props.createVpc,
      userId: props.userId,
      vpcCidr: props.vpcCidr,
    });

    // 2. Storage
    const storage = new StorageConstruct(this, 'Storage', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnet: networking.privateSubnet,
      fsxCapacityGiB: props.fsxCapacityGiB,
    });

    // 3. HyperPod Cluster
    const cluster = new HyperPodClusterConstruct(this, 'HyperPod', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnet: networking.privateSubnet,
      fsxSecurityGroup: storage.securityGroup,
      dataBucket: storage.bucket,
      ...clusterConfig,
    });

    // 4. MLflow
    const mlflow = new MlflowConstruct(this, 'MLflow', {
      namePrefix,
      artifactBucket: storage.bucket,
    });

    // Stack Outputs
    new cdk.CfnOutput(this, 'S3BucketName', {
      value: storage.bucket.ref,
      description: 'Data S3 Bucket',
    });
    new cdk.CfnOutput(this, 'FsxFileSystemId', {
      value: storage.fileSystem.ref,
      description: 'FSx for Lustre File System ID',
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: networking.vpc.ref,
      description: 'VPC ID',
    });
    new cdk.CfnOutput(this, 'PrivateSubnetId', {
      value: networking.privateSubnet.ref,
      description: 'Private Subnet ID',
    });
  }
}
```

- [ ] **Step 2: Run cdk synth to validate**

```bash
cd training/hyperpod/cdk && npx cdk synth --no-staging 2>&1 | head -50
```

Expected: CloudFormation template YAML output (may warn about env not being set, that's OK)

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/cdk/lib/hyperpod-stack.ts
git commit -m "feat(hyperpod): main stack composing all constructs"
```

---

## Task 7: Lifecycle Scripts

**Files:**
- Create: `training/hyperpod/lifecycle-scripts/on_create.sh`
- Create: `training/hyperpod/lifecycle-scripts/setup_slurm.sh`
- Create: `training/hyperpod/lifecycle-scripts/setup_fsx.sh`

- [ ] **Step 1: Create on_create.sh**

```bash
#!/bin/bash
set -euo pipefail

# HyperPod 노드 초기화 스크립트
# Enroot, Pyxis, NVIDIA Container Toolkit 설치

echo "[on_create] Starting node initialization..."

# Enroot 설치
ENROOT_VERSION="3.5.0"
curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot_${ENROOT_VERSION}-1_amd64.deb"
curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot+caps_${ENROOT_VERSION}-1_amd64.deb"
apt-get update -y
apt-get install -y ./"enroot_${ENROOT_VERSION}-1_amd64.deb" ./"enroot+caps_${ENROOT_VERSION}-1_amd64.deb"
rm -f enroot*.deb

# Enroot 설정
mkdir -p /etc/enroot
cat > /etc/enroot/enroot.conf <<'ENROOT_CONF'
ENROOT_RUNTIME_PATH=/run/enroot/user-$(id -u)
ENROOT_CACHE_PATH=/tmp/enroot-cache
ENROOT_DATA_PATH=/tmp/enroot-data
ENROOT_SQUASH_OPTIONS="-noI -noD -noF -noX -no-duplicates"
ENROOT_MOUNT_HOME=y
ENROOT_RESTRICT_DEV=y
ENROOT_ROOTFS_WRITABLE=y
ENROOT_CONF

# Pyxis (SLURM container plugin) 설치
PYXIS_VERSION="0.20.0"
git clone --depth 1 --branch "v${PYXIS_VERSION}" https://github.com/NVIDIA/pyxis.git /tmp/pyxis
cd /tmp/pyxis && make install && cd - && rm -rf /tmp/pyxis

# SLURM plugstack 설정
mkdir -p /etc/slurm
echo "required /usr/local/lib/slurm/spank_pyxis.so" > /etc/slurm/plugstack.conf

# FSx 마운트
bash /opt/ml/scripts/setup_fsx.sh

# SLURM 파티션 설정
bash /opt/ml/scripts/setup_slurm.sh

echo "[on_create] Node initialization complete."
```

- [ ] **Step 2: Create setup_fsx.sh**

```bash
#!/bin/bash
set -euo pipefail

# FSx for Lustre 마운트 스크립트
# HyperPod 노드에서 /fsx로 마운트

FSX_DNS_NAME="${FSX_DNS_NAME:-}"
FSX_MOUNT_NAME="${FSX_MOUNT_NAME:-}"

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  echo "[setup_fsx] FSX_DNS_NAME or FSX_MOUNT_NAME not set. Skipping mount."
  exit 0
fi

echo "[setup_fsx] Mounting FSx at /fsx..."

# Lustre 클라이언트 설치
apt-get update -y
apt-get install -y lustre-client-modules-aws lustre-client-modules-$(uname -r) || \
  apt-get install -y lustre-client-modules-aws

# 마운트 포인트 생성
mkdir -p /fsx

# 마운트
mount -t lustre "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME}" /fsx

# /etc/fstab에 추가 (재부팅 시 자동 마운트)
echo "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab

# 디렉토리 구조 생성
mkdir -p /fsx/datasets /fsx/checkpoints /fsx/scratch
chmod 777 /fsx/scratch

echo "[setup_fsx] FSx mounted at /fsx successfully."
```

- [ ] **Step 3: Create setup_slurm.sh**

```bash
#!/bin/bash
set -euo pipefail

# SLURM 파티션 및 오토스케일링 설정
# HyperPod는 SLURM을 자동 설치하지만, 파티션 설정은 lifecycle script에서 수행

echo "[setup_slurm] Configuring SLURM partitions..."

NODE_TYPE="${SAGEMAKER_INSTANCE_GROUP_NAME:-unknown}"

# head 노드에서만 SLURM 설정 파일 생성
if [ "$NODE_TYPE" = "head" ]; then
  cat >> /opt/slurm/etc/slurm.conf <<'SLURM_PARTITIONS'

# Partition definitions
PartitionName=sim Default=NO MaxTime=INFINITE State=UP
PartitionName=train Default=YES MaxTime=INFINITE State=UP
PartitionName=debug Default=NO MaxTime=4:00:00 State=UP

# Autoscaling
SuspendTime=600
ResumeTimeout=900
SuspendTimeout=300
SLURM_PARTITIONS

  # SLURM 재시작
  systemctl restart slurmctld

  echo "[setup_slurm] SLURM partitions configured on head node."
else
  echo "[setup_slurm] Worker node ($NODE_TYPE). No partition config needed."
fi
```

- [ ] **Step 4: Make scripts executable and commit**

```bash
chmod +x training/hyperpod/lifecycle-scripts/*.sh
git add training/hyperpod/lifecycle-scripts/
git commit -m "feat(hyperpod): lifecycle scripts (Enroot, FSx, SLURM)"
```

---

## Task 8: Cluster Config (수동 배포용)

**Files:**
- Create: `training/hyperpod/cluster-config/cluster-config.json`
- Create: `training/hyperpod/cluster-config/provisioning-params.json`
- Create: `training/hyperpod/cluster-config/manual-setup.md`

- [ ] **Step 1: Create cluster-config.json**

```json
{
  "ClusterName": "hyperpod-robotics",
  "InstanceGroups": [
    {
      "InstanceGroupName": "head",
      "InstanceType": "ml.m5.xlarge",
      "InstanceCount": 1,
      "LifeCycleConfig": {
        "SourceS3Uri": "s3://LIFECYCLE_BUCKET/lifecycle-scripts/",
        "OnCreate": "on_create.sh"
      }
    },
    {
      "InstanceGroupName": "sim",
      "InstanceType": "ml.g5.12xlarge",
      "InstanceCount": 16,
      "LifeCycleConfig": {
        "SourceS3Uri": "s3://LIFECYCLE_BUCKET/lifecycle-scripts/",
        "OnCreate": "on_create.sh"
      }
    },
    {
      "InstanceGroupName": "train",
      "InstanceType": "ml.g6e.12xlarge",
      "InstanceCount": 4,
      "LifeCycleConfig": {
        "SourceS3Uri": "s3://LIFECYCLE_BUCKET/lifecycle-scripts/",
        "OnCreate": "on_create.sh"
      }
    },
    {
      "InstanceGroupName": "debug",
      "InstanceType": "ml.g5.4xlarge",
      "InstanceCount": 1,
      "LifeCycleConfig": {
        "SourceS3Uri": "s3://LIFECYCLE_BUCKET/lifecycle-scripts/",
        "OnCreate": "on_create.sh"
      }
    }
  ],
  "VpcConfig": {
    "SecurityGroupIds": ["sg-REPLACE"],
    "Subnets": ["subnet-REPLACE"]
  }
}
```

- [ ] **Step 2: Create provisioning-params.json**

```json
{
  "version": "1.0.0",
  "workload_manager": "slurm",
  "controller_group": "head",
  "worker_groups": [
    {
      "instance_group_name": "sim",
      "partition_name": "sim"
    },
    {
      "instance_group_name": "train",
      "partition_name": "train"
    },
    {
      "instance_group_name": "debug",
      "partition_name": "debug"
    }
  ],
  "fsx_dns_name": "FSX_DNS_REPLACE",
  "fsx_mountname": "FSX_MOUNT_REPLACE"
}
```

- [ ] **Step 3: Create manual-setup.md**

```markdown
# HyperPod 수동 배포 가이드

CDK 대신 AWS CLI로 직접 배포하는 방법.

## 사전 준비

1. VPC + Private Subnet + NAT Gateway 생성 완료
2. FSx for Lustre 파일시스템 생성 완료
3. S3에 lifecycle scripts 업로드 완료

## Step 1: Lifecycle Scripts 업로드

\`\`\`bash
LIFECYCLE_BUCKET="your-lifecycle-bucket"
aws s3 cp lifecycle-scripts/ s3://${LIFECYCLE_BUCKET}/lifecycle-scripts/ --recursive
\`\`\`

## Step 2: cluster-config.json 편집

- `LIFECYCLE_BUCKET`: 위에서 사용한 S3 버킷명
- `sg-REPLACE`: VPC 내 보안 그룹 ID
- `subnet-REPLACE`: Private Subnet ID

## Step 3: provisioning-params.json 업로드

\`\`\`bash
aws s3 cp provisioning-params.json s3://${LIFECYCLE_BUCKET}/lifecycle-scripts/provisioning_parameters.json
\`\`\`

## Step 4: 클러스터 생성

\`\`\`bash
aws sagemaker create-cluster \
  --cli-input-json file://cluster-config.json
\`\`\`

## Step 5: 클러스터 상태 확인

\`\`\`bash
aws sagemaker describe-cluster --cluster-name hyperpod-robotics
\`\`\`

## Step 6: Head Node 접속

\`\`\`bash
# 클러스터 노드 목록 조회
aws sagemaker list-cluster-nodes --cluster-name hyperpod-robotics

# SSM으로 접속 (head node의 instance ID 사용)
aws ssm start-session --target sagemaker-cluster:CLUSTER_ID_head-0
\`\`\`

## Step 7: 클러스터 삭제

\`\`\`bash
aws sagemaker delete-cluster --cluster-name hyperpod-robotics
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add training/hyperpod/cluster-config/
git commit -m "feat(hyperpod): 수동 배포용 cluster config + CLI 가이드"
```

---

## Task 9: SLURM Templates (RL)

**Files:**
- Create: `training/hyperpod/slurm-templates/rl/actor.sbatch`
- Create: `training/hyperpod/slurm-templates/rl/learner.sbatch`
- Create: `training/hyperpod/slurm-templates/rl/run_rl.sh`

- [ ] **Step 1: Create actor.sbatch**

```bash
#!/bin/bash
#SBATCH --job-name=rl-actor
#SBATCH --partition=sim
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --time=24:00:00
#SBATCH --output=/fsx/scratch/logs/actor-%j-%a.out
#SBATCH --error=/fsx/scratch/logs/actor-%j-%a.err

# IsaacLab RL Actor (headless simulation)
# Ray worker로 learner에 연결하여 environment step 실행

RAY_HEAD_ADDR="${RAY_HEAD_ADDR:?Set RAY_HEAD_ADDR to learner node IP}"
ENV_NAME="${ENV_NAME:-Isaac-Cartpole-v0}"

srun --container-image=nvcr.io/nvidia/isaac-sim:4.5.0 \
     --container-mounts=/fsx:/fsx \
     bash -c "
       pip install ray[default] && \
       ray start --address=${RAY_HEAD_ADDR}:6379 --block
     "
```

- [ ] **Step 2: Create learner.sbatch**

```bash
#!/bin/bash
#SBATCH --job-name=rl-learner
#SBATCH --partition=train
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --time=48:00:00
#SBATCH --output=/fsx/scratch/logs/learner-%j.out
#SBATCH --error=/fsx/scratch/logs/learner-%j.err

# RL Learner (Ray head node + training loop)
# Actor들이 이 노드에 연결하여 trajectory를 전송

ENV_NAME="${ENV_NAME:-Isaac-Cartpole-v0}"
EXPERIMENT="${EXPERIMENT:-rl-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
NUM_ACTORS="${NUM_ACTORS:-8}"

export MLFLOW_TRACKING_URI

srun --container-image=nvcr.io/nvidia/isaac-sim:4.5.0 \
     --container-mounts=/fsx:/fsx \
     bash -c "
       pip install ray[default] mlflow && \
       ray start --head --port=6379 && \
       python /fsx/scratch/train_isaaclab.py \
         --env ${ENV_NAME} \
         --experiment ${EXPERIMENT} \
         --num-actors ${NUM_ACTORS} \
         --checkpoint-dir /fsx/checkpoints/rl/${EXPERIMENT}
     "

echo "Learner finished. Ray head address: $(hostname -i):6379"
```

- [ ] **Step 3: Create run_rl.sh**

```bash
#!/bin/bash
set -euo pipefail

# Actor-Learner 동시 제출 스크립트
# Usage: ./run_rl.sh --env Isaac-Humanoid-v0 --num-actors 8

ENV_NAME="Isaac-Cartpole-v0"
NUM_ACTORS=8
EXPERIMENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --env) ENV_NAME="$2"; shift 2;;
    --num-actors) NUM_ACTORS="$2"; shift 2;;
    --experiment) EXPERIMENT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

EXPERIMENT="${EXPERIMENT:-rl-${ENV_NAME}-$(date +%Y%m%d-%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== RL Training: ${ENV_NAME} ==="
echo "  Actors: ${NUM_ACTORS}"
echo "  Experiment: ${EXPERIMENT}"

# 로그 디렉토리 생성
mkdir -p /fsx/scratch/logs

# 1. Learner 제출
LEARNER_JOB=$(sbatch --parsable \
  --export=ALL,ENV_NAME=${ENV_NAME},EXPERIMENT=${EXPERIMENT},NUM_ACTORS=${NUM_ACTORS} \
  "${SCRIPT_DIR}/learner.sbatch")
echo "  Learner job: ${LEARNER_JOB}"

# Learner가 시작될 때까지 대기 (Ray head 준비)
echo "  Waiting for learner to start..."
while [ "$(squeue -j ${LEARNER_JOB} -h -o %T)" = "PENDING" ]; do
  sleep 5
done
sleep 30  # Ray head 초기화 대기

# Learner 노드 IP 조회
LEARNER_NODE=$(squeue -j ${LEARNER_JOB} -h -o %N)
RAY_HEAD_ADDR=$(srun --jobid=${LEARNER_JOB} --nodelist=${LEARNER_NODE} hostname -i 2>/dev/null | head -1)
echo "  Ray head: ${RAY_HEAD_ADDR}"

# 2. Actor 배열 제출
ACTOR_JOB=$(sbatch --parsable \
  --array=0-$((NUM_ACTORS-1)) \
  --export=ALL,RAY_HEAD_ADDR=${RAY_HEAD_ADDR},ENV_NAME=${ENV_NAME} \
  "${SCRIPT_DIR}/actor.sbatch")
echo "  Actor jobs: ${ACTOR_JOB} (array 0-$((NUM_ACTORS-1)))"

echo ""
echo "=== Submitted ==="
echo "  Monitor: squeue -u \$USER"
echo "  Cancel:  scancel ${LEARNER_JOB} ${ACTOR_JOB}"
echo "  Logs:    /fsx/scratch/logs/"
```

- [ ] **Step 4: Make executable and commit**

```bash
chmod +x training/hyperpod/slurm-templates/rl/run_rl.sh
git add training/hyperpod/slurm-templates/rl/
git commit -m "feat(hyperpod): RL SLURM templates (Actor-Learner on Ray)"
```

---

## Task 10: SLURM Templates (VLA)

**Files:**
- Create: `training/hyperpod/slurm-templates/vla/finetune_groot.sbatch`
- Create: `training/hyperpod/slurm-templates/vla/finetune_pi0.sbatch`
- Create: `training/hyperpod/slurm-templates/vla/run_vla.sh`

- [ ] **Step 1: Create finetune_groot.sbatch**

```bash
#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --partition=train
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --cpus-per-gpu=12
#SBATCH --time=24:00:00
#SBATCH --output=/fsx/scratch/logs/groot-%j.out
#SBATCH --error=/fsx/scratch/logs/groot-%j.err

# GR00T-N1.6-3B Fine-tuning (PyTorch DDP)
# 4× L40S (48GB each) on g6e.12xlarge

DATASET="${DATASET:-aloha}"
EPOCHS="${EPOCHS:-50}"
BATCH_SIZE="${BATCH_SIZE:-32}"
LR="${LR:-1e-4}"
EXPERIMENT="${EXPERIMENT:-groot-${DATASET}-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
CHECKPOINT_DIR="/fsx/checkpoints/vla/${EXPERIMENT}"

export MLFLOW_TRACKING_URI

mkdir -p "${CHECKPOINT_DIR}" /fsx/scratch/logs

srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_groot.py \
       --dataset-path "/fsx/datasets/groot/${DATASET}" \
       --output-dir "${CHECKPOINT_DIR}" \
       --epochs "${EPOCHS}" \
       --batch-size "${BATCH_SIZE}" \
       --lr "${LR}" \
       --experiment "${EXPERIMENT}"
```

- [ ] **Step 2: Create finetune_pi0.sbatch**

```bash
#!/bin/bash
#SBATCH --job-name=pi0-finetune
#SBATCH --partition=train
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --cpus-per-gpu=12
#SBATCH --time=48:00:00
#SBATCH --output=/fsx/scratch/logs/pi0-%j.out
#SBATCH --error=/fsx/scratch/logs/pi0-%j.err

# π0 Fine-tuning (PyTorch DDP)
# 4× L40S (48GB each) on g6e.12xlarge

DATASET="${DATASET:-bridge_v2}"
EPOCHS="${EPOCHS:-100}"
BATCH_SIZE="${BATCH_SIZE:-16}"
LR="${LR:-5e-5}"
EXPERIMENT="${EXPERIMENT:-pi0-${DATASET}-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
CHECKPOINT_DIR="/fsx/checkpoints/vla/${EXPERIMENT}"

export MLFLOW_TRACKING_URI

mkdir -p "${CHECKPOINT_DIR}" /fsx/scratch/logs

srun --container-image=docker://ghcr.io/physical-intelligence/openpi:latest \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_pi0.py \
       --dataset-path "/fsx/datasets/pi0/${DATASET}" \
       --output-dir "${CHECKPOINT_DIR}" \
       --epochs "${EPOCHS}" \
       --batch-size "${BATCH_SIZE}" \
       --lr "${LR}" \
       --experiment "${EXPERIMENT}"
```

- [ ] **Step 3: Create run_vla.sh**

```bash
#!/bin/bash
set -euo pipefail

# VLA 학습 실행 래퍼
# Usage: ./run_vla.sh --model groot --dataset aloha --epochs 50

MODEL="groot"
DATASET=""
EPOCHS=""
NODES=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2;;
    --dataset) DATASET="$2"; shift 2;;
    --epochs) EPOCHS="$2"; shift 2;;
    --nodes) NODES="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [ -z "$DATASET" ]; then
  echo "Usage: ./run_vla.sh --model [groot|pi0] --dataset <name> [--epochs N] [--nodes N]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case $MODEL in
  groot) SBATCH_FILE="${SCRIPT_DIR}/finetune_groot.sbatch";;
  pi0)   SBATCH_FILE="${SCRIPT_DIR}/finetune_pi0.sbatch";;
  *)     echo "Unknown model: ${MODEL}. Use 'groot' or 'pi0'"; exit 1;;
esac

EXPORT_VARS="ALL,DATASET=${DATASET}"
[ -n "$EPOCHS" ] && EXPORT_VARS="${EXPORT_VARS},EPOCHS=${EPOCHS}"

JOB_ID=$(sbatch --parsable --nodes=${NODES} --export="${EXPORT_VARS}" "${SBATCH_FILE}")

echo "=== VLA Training Submitted ==="
echo "  Model:    ${MODEL}"
echo "  Dataset:  ${DATASET}"
echo "  Nodes:    ${NODES}"
echo "  Job ID:   ${JOB_ID}"
echo ""
echo "  Monitor:  squeue -j ${JOB_ID}"
echo "  Logs:     /fsx/scratch/logs/${MODEL}-${JOB_ID}.out"
echo "  Cancel:   scancel ${JOB_ID}"
```

- [ ] **Step 4: Make executable and commit**

```bash
chmod +x training/hyperpod/slurm-templates/vla/run_vla.sh
git add training/hyperpod/slurm-templates/vla/
git commit -m "feat(hyperpod): VLA SLURM templates (GR00T, π0 fine-tuning)"
```

---

## Task 11: SLURM Template (DCV Debug)

**Files:**
- Create: `training/hyperpod/slurm-templates/debug/dcv_session.sbatch`

- [ ] **Step 1: Create dcv_session.sbatch**

```bash
#!/bin/bash
#SBATCH --job-name=dcv-debug
#SBATCH --partition=debug
#SBATCH --nodes=1
#SBATCH --gpus-per-node=1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/dcv-%j.out
#SBATCH --error=/fsx/scratch/logs/dcv-%j.err

# DCV 시각화 세션
# Isaac Sim GUI로 학습된 모델을 검증

CHECKPOINT="${CHECKPOINT:-}"

echo "=== DCV Debug Session ==="
echo "  Node: $(hostname)"
echo "  GPU:  $(nvidia-smi --query-gpu=name --format=csv,noheader)"

# DCV 서버 시작
dcv create-session --type virtual --name debug-session
DCV_PORT=8443

# 접속 정보 출력
NODE_IP=$(hostname -i)
echo ""
echo "=== DCV 접속 방법 ==="
echo "  1. SSM 포트포워딩:"
echo "     aws ssm start-session --target \$(scontrol show node \$(hostname) | grep -oP 'NodeAddr=\K[^[:space:]]+') \\"
echo "       --document-name AWS-StartPortForwardingSession \\"
echo "       --parameters portNumber=${DCV_PORT},localPortNumber=${DCV_PORT}"
echo ""
echo "  2. 브라우저에서 접속:"
echo "     https://localhost:${DCV_PORT}"
echo ""

if [ -n "$CHECKPOINT" ]; then
  echo "  Checkpoint: ${CHECKPOINT}"
  echo "  Isaac Sim에서 모델 로드:"
  echo "    python /fsx/scratch/verify_in_sim.py --checkpoint ${CHECKPOINT}"
fi

echo ""
echo "세션 종료: scancel ${SLURM_JOB_ID}"

# 세션 유지 (job이 살아있는 동안 DCV 접속 가능)
sleep infinity
```

- [ ] **Step 2: Commit**

```bash
git add training/hyperpod/slurm-templates/debug/
git commit -m "feat(hyperpod): DCV debug session SLURM template"
```

---

## Task 12: Example Code (VLA Training)

**Files:**
- Create: `training/hyperpod/examples/vla/train_groot.py`
- Create: `training/hyperpod/examples/vla/train_pi0.py`
- Create: `training/hyperpod/examples/vla/verify_in_sim.py`

- [ ] **Step 1: Create train_groot.py**

```python
"""GR00T-N1.6-3B Fine-tuning 최소 예시.

Usage:
  torchrun --nproc_per_node=4 train_groot.py \
    --dataset-path /fsx/datasets/groot/aloha \
    --output-dir /fsx/checkpoints/vla/groot-aloha \
    --epochs 50
"""
import argparse
import os

import mlflow
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data import DataLoader
from torch.utils.data.distributed import DistributedSampler


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-path", type=str, required=True)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--experiment", type=str, default="groot-finetune")
    return parser.parse_args()


def setup_distributed():
    dist.init_process_group(backend="nccl")
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    return local_rank


def main():
    args = parse_args()
    local_rank = setup_distributed()
    rank = dist.get_rank()

    # MLflow (rank 0만 기록)
    if rank == 0:
        mlflow.set_experiment(args.experiment)
        mlflow.start_run()
        mlflow.log_params(vars(args))

    # 모델 로드 (GR00T)
    # NOTE: 실제 사용 시 gr00t 패키지의 모델 로딩 코드로 교체
    from gr00t.model import GR00TModel
    model = GR00TModel.from_pretrained("nvidia/GR00T-N1.6-3B")
    model = model.to(local_rank)
    model = DDP(model, device_ids=[local_rank])

    # 데이터 로드 (LeRobot v2 형식)
    from gr00t.data import LeRobotDataset
    dataset = LeRobotDataset(args.dataset_path)
    sampler = DistributedSampler(dataset)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, sampler=sampler)

    # Optimizer
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    # Training loop
    for epoch in range(args.epochs):
        sampler.set_epoch(epoch)
        epoch_loss = 0.0

        for batch in dataloader:
            batch = {k: v.to(local_rank) for k, v in batch.items()}
            loss = model(batch)
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            epoch_loss += loss.item()

        avg_loss = epoch_loss / len(dataloader)

        if rank == 0:
            mlflow.log_metric("loss", avg_loss, step=epoch)
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.4f}")

            # 체크포인트 저장 (10 에폭마다)
            if (epoch + 1) % 10 == 0:
                ckpt_path = os.path.join(args.output_dir, f"checkpoint-{epoch+1}.pt")
                torch.save(model.module.state_dict(), ckpt_path)
                mlflow.log_artifact(ckpt_path)

    # 최종 모델 저장
    if rank == 0:
        final_path = os.path.join(args.output_dir, "model_final.pt")
        torch.save(model.module.state_dict(), final_path)
        mlflow.log_artifact(final_path)
        mlflow.end_run()

    dist.destroy_process_group()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create train_pi0.py**

```python
"""π0 Fine-tuning 최소 예시.

Usage:
  torchrun --nproc_per_node=4 train_pi0.py \
    --dataset-path /fsx/datasets/pi0/bridge_v2 \
    --output-dir /fsx/checkpoints/vla/pi0-bridge \
    --epochs 100
"""
import argparse
import os

import mlflow
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data import DataLoader
from torch.utils.data.distributed import DistributedSampler


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-path", type=str, required=True)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--experiment", type=str, default="pi0-finetune")
    return parser.parse_args()


def setup_distributed():
    dist.init_process_group(backend="nccl")
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    return local_rank


def main():
    args = parse_args()
    local_rank = setup_distributed()
    rank = dist.get_rank()

    if rank == 0:
        mlflow.set_experiment(args.experiment)
        mlflow.start_run()
        mlflow.log_params(vars(args))

    # 모델 로드 (π0)
    # NOTE: 실제 사용 시 openpi 패키지의 모델 로딩 코드로 교체
    from openpi.model import Pi0Model
    model = Pi0Model.from_pretrained("physical-intelligence/pi0")
    model = model.to(local_rank)
    model = DDP(model, device_ids=[local_rank])

    # 데이터 로드
    from openpi.data import ActionDataset
    dataset = ActionDataset(args.dataset_path)
    sampler = DistributedSampler(dataset)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, sampler=sampler)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        sampler.set_epoch(epoch)
        epoch_loss = 0.0
        correct = 0
        total = 0

        for batch in dataloader:
            batch = {k: v.to(local_rank) for k, v in batch.items()}
            outputs = model(batch)
            loss = outputs["loss"]
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()

            epoch_loss += loss.item()
            correct += outputs.get("correct", 0)
            total += batch["actions"].shape[0]

        avg_loss = epoch_loss / len(dataloader)
        accuracy = correct / total if total > 0 else 0.0

        if rank == 0:
            mlflow.log_metrics({"loss": avg_loss, "accuracy": accuracy}, step=epoch)
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.4f}, Acc: {accuracy:.3f}")

            if (epoch + 1) % 20 == 0:
                ckpt_path = os.path.join(args.output_dir, f"checkpoint-{epoch+1}.pt")
                torch.save(model.module.state_dict(), ckpt_path)
                mlflow.log_artifact(ckpt_path)

    if rank == 0:
        final_path = os.path.join(args.output_dir, "model_final.pt")
        torch.save(model.module.state_dict(), final_path)
        mlflow.log_artifact(final_path)
        mlflow.end_run()

    dist.destroy_process_group()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Create verify_in_sim.py**

```python
"""학습된 VLA/RL 모델을 Isaac Sim에서 검증하는 스크립트.

DCV debug 세션에서 실행:
  python verify_in_sim.py --checkpoint /fsx/checkpoints/vla/groot-aloha/model_final.pt

Isaac Sim GUI에서 로봇이 policy에 따라 동작하는 것을 시각적으로 확인한다.
"""
import argparse

import torch


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=str, required=True)
    parser.add_argument("--env", type=str, default="Isaac-Lift-Franka-v0")
    parser.add_argument("--num-episodes", type=int, default=10)
    parser.add_argument("--render", action="store_true", default=True)
    return parser.parse_args()


def main():
    args = parse_args()

    # Isaac Sim 초기화 (GUI 모드)
    from omni.isaac.lab.app import AppLauncher
    app_launcher = AppLauncher(headless=not args.render)
    simulation_app = app_launcher.app

    import omni.isaac.lab_tasks  # noqa: F401
    import gymnasium as gym

    # 환경 생성
    env = gym.make(args.env, render_mode="human" if args.render else None)

    # 모델 로드
    device = torch.device("cuda:0")
    model_state = torch.load(args.checkpoint, map_location=device)

    # NOTE: 실제 사용 시 모델 아키텍처에 맞게 로드 방식 변경
    from gr00t.model import GR00TModel
    model = GR00TModel.from_pretrained("nvidia/GR00T-N1.6-3B")
    model.load_state_dict(model_state)
    model = model.to(device).eval()

    # 검증 루프
    success_count = 0
    for episode in range(args.num_episodes):
        obs, info = env.reset()
        done = False
        steps = 0

        while not done:
            with torch.no_grad():
                obs_tensor = {k: torch.tensor(v).unsqueeze(0).to(device) for k, v in obs.items()}
                action = model.predict(obs_tensor)
                action = action.squeeze(0).cpu().numpy()

            obs, reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated
            steps += 1

        success = info.get("is_success", False)
        success_count += int(success)
        print(f"Episode {episode+1}: {'SUCCESS' if success else 'FAIL'} ({steps} steps)")

    print(f"\nResults: {success_count}/{args.num_episodes} success ({100*success_count/args.num_episodes:.0f}%)")

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Commit**

```bash
git add training/hyperpod/examples/vla/
git commit -m "feat(hyperpod): VLA 예시 코드 (GR00T, π0, Isaac Sim 검증)"
```

---

## Task 13: Example Code (RL Training)

**Files:**
- Create: `training/hyperpod/examples/rl/train_isaaclab.py`
- Create: `training/hyperpod/examples/rl/ray_config.yaml`

- [ ] **Step 1: Create train_isaaclab.py**

```python
"""IsaacLab RL 학습 (Actor-Learner with Ray).

Learner 노드에서 실행. Ray workers (actors)가 sim 파티션에서 환경 step을 수행하고,
learner가 policy를 업데이트한다.

Usage:
  python train_isaaclab.py \
    --env Isaac-Cartpole-v0 \
    --num-actors 8 \
    --checkpoint-dir /fsx/checkpoints/rl/cartpole-001
"""
import argparse
import os

import mlflow
import ray
import torch


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=str, default="Isaac-Cartpole-v0")
    parser.add_argument("--num-actors", type=int, default=8)
    parser.add_argument("--total-timesteps", type=int, default=10_000_000)
    parser.add_argument("--checkpoint-dir", type=str, required=True)
    parser.add_argument("--checkpoint-freq", type=int, default=100_000)
    parser.add_argument("--experiment", type=str, default="rl-training")
    return parser.parse_args()


@ray.remote(num_gpus=1)
class IsaacLabActor:
    """IsaacLab 환경을 실행하는 Ray Actor."""

    def __init__(self, env_name: str, actor_id: int):
        from omni.isaac.lab.app import AppLauncher
        app_launcher = AppLauncher(headless=True)

        import omni.isaac.lab_tasks  # noqa: F401
        import gymnasium as gym

        self.env = gym.make(env_name)
        self.actor_id = actor_id

    def rollout(self, policy_weights):
        """하나의 에피소드를 수행하고 trajectory를 반환."""
        obs, _ = self.env.reset()
        trajectory = []
        done = False

        while not done:
            action = self._get_action(obs, policy_weights)
            next_obs, reward, terminated, truncated, info = self.env.step(action)
            trajectory.append((obs, action, reward, next_obs, terminated))
            obs = next_obs
            done = terminated or truncated

        return trajectory

    def _get_action(self, obs, policy_weights):
        # 간단한 MLP policy 평가
        import numpy as np
        obs_flat = np.concatenate([v.flatten() for v in obs.values()])
        # NOTE: 실제 구현에서는 policy network forward pass
        return self.env.action_space.sample()


def main():
    args = parse_args()

    ray.init()
    os.makedirs(args.checkpoint_dir, exist_ok=True)

    # MLflow 설정
    mlflow.set_experiment(args.experiment)
    mlflow.start_run()
    mlflow.log_params(vars(args))

    # Actor 생성
    actors = [IsaacLabActor.remote(args.env, i) for i in range(args.num_actors)]

    # 학습 루프
    total_steps = 0
    episode_count = 0
    policy_weights = None  # 초기 policy

    while total_steps < args.total_timesteps:
        # 모든 actor에서 병렬 rollout
        trajectory_futures = [actor.rollout.remote(policy_weights) for actor in actors]
        trajectories = ray.get(trajectory_futures)

        # 학습 업데이트
        for traj in trajectories:
            episode_reward = sum(t[2] for t in traj)
            episode_length = len(traj)
            total_steps += episode_length
            episode_count += 1

            mlflow.log_metrics({
                "reward": episode_reward,
                "episode_length": episode_length,
                "total_steps": total_steps,
            }, step=episode_count)

        # 체크포인트
        if total_steps % args.checkpoint_freq < args.num_actors * 1000:
            ckpt_path = os.path.join(args.checkpoint_dir, f"step-{total_steps}.pt")
            torch.save({"step": total_steps, "policy": policy_weights}, ckpt_path)
            print(f"[Step {total_steps}] Checkpoint saved: {ckpt_path}")

    mlflow.end_run()
    ray.shutdown()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create ray_config.yaml**

```yaml
# Ray on SLURM 설정
# HyperPod 클러스터에서 Ray 클러스터를 SLURM job으로 실행할 때 참고

cluster_name: isaaclab-rl

# Ray head (learner 노드에서 실행)
head:
  partition: train
  resources:
    gpus: 4
    cpus: 48

# Ray workers (sim 노드에서 실행)
workers:
  partition: sim
  min_workers: 1
  max_workers: 16
  resources_per_worker:
    gpus: 4
    cpus: 48

# 환경 변수
env_vars:
  NCCL_DEBUG: INFO
  RAY_DEDUP_LOGS: "0"

# 오토스케일링 설정
autoscaler:
  target_utilization_fraction: 0.8
  idle_timeout_minutes: 10
```

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/examples/rl/
git commit -m "feat(hyperpod): RL 예시 코드 (IsaacLab Actor-Learner on Ray)"
```

---

## Task 14: MLflow Setup and Examples

**Files:**
- Create: `training/hyperpod/mlflow/setup.sh`
- Create: `training/hyperpod/mlflow/example_usage.py`
- Create: `training/hyperpod/examples/mlflow/example_tracking.py`

- [ ] **Step 1: Create mlflow/setup.sh**

```bash
#!/bin/bash
set -euo pipefail

# SageMaker Managed MLflow 초기 설정 확인 스크립트
# HyperPod head-node에서 실행

echo "=== SageMaker MLflow Setup ==="

# 1. MLflow SDK 설치
pip install mlflow sagemaker-mlflow boto3

# 2. Tracking URI 확인 (CDK output에서 가져오기)
TRACKING_URI="${MLFLOW_TRACKING_URI:-}"
if [ -z "$TRACKING_URI" ]; then
  echo ""
  echo "MLFLOW_TRACKING_URI가 설정되지 않았습니다."
  echo "CDK 배포 후 출력된 MlflowTrackingUri 값을 사용하세요:"
  echo ""
  echo "  export MLFLOW_TRACKING_URI=<CDK output의 MlflowTrackingUri>"
  echo ""
  echo "또는 ~/.bashrc에 추가:"
  echo "  echo 'export MLFLOW_TRACKING_URI=...' >> ~/.bashrc"
  exit 1
fi

# 3. 연결 테스트
echo "Testing connection to: ${TRACKING_URI}"
python -c "
import mlflow
mlflow.set_tracking_uri('${TRACKING_URI}')
client = mlflow.MlflowClient()
experiments = client.search_experiments()
print(f'Connected! Found {len(experiments)} experiments.')
"

echo ""
echo "=== Setup Complete ==="
echo "MLflow UI: SageMaker Studio > MLflow 에서 확인"
```

- [ ] **Step 2: Create mlflow/example_usage.py**

```python
"""SageMaker Managed MLflow 사용 예시.

HyperPod 노드에서 실행:
  export MLFLOW_TRACKING_URI=<CDK output>
  python example_usage.py
"""
import os

import mlflow

TRACKING_URI = os.environ["MLFLOW_TRACKING_URI"]
mlflow.set_tracking_uri(TRACKING_URI)


def example_rl_logging():
    """RL 학습 중 MLflow 기록 예시."""
    mlflow.set_experiment("rl-cartpole-demo")

    with mlflow.start_run(run_name="ppo-baseline"):
        # 하이퍼파라미터 기록
        mlflow.log_params({
            "algorithm": "PPO",
            "env": "Isaac-Cartpole-v0",
            "num_actors": 8,
            "lr": 3e-4,
            "gamma": 0.99,
        })

        # 학습 메트릭 기록 (시뮬레이션)
        for step in range(100):
            mlflow.log_metrics({
                "reward": 50.0 + step * 2,
                "episode_length": 100 + step * 5,
                "policy_loss": 1.0 / (step + 1),
            }, step=step)

        # 체크포인트 기록
        # mlflow.log_artifact("/fsx/checkpoints/rl/model.pt")

    print("RL logging example complete.")


def example_vla_logging():
    """VLA 학습 중 MLflow 기록 예시."""
    mlflow.set_experiment("vla-groot-demo")

    with mlflow.start_run(run_name="groot-aloha-finetune"):
        mlflow.log_params({
            "model": "GR00T-N1.6-3B",
            "dataset": "aloha",
            "epochs": 50,
            "batch_size": 32,
            "lr": 1e-4,
        })

        for epoch in range(50):
            mlflow.log_metrics({
                "loss": 2.0 / (epoch + 1),
                "accuracy": min(0.95, 0.5 + epoch * 0.01),
                "learning_rate": 1e-4 * (0.95 ** epoch),
            }, step=epoch)

        # mlflow.log_artifact("/fsx/checkpoints/vla/model_final.pt")

    print("VLA logging example complete.")


if __name__ == "__main__":
    example_rl_logging()
    example_vla_logging()
    print("\nMLflow UI에서 확인: SageMaker Studio > MLflow")
```

- [ ] **Step 3: Create examples/mlflow/example_tracking.py (symlink or copy)**

```python
"""MLflow 기록 통합 예시 — RL과 VLA 모두 포함.

이 파일은 mlflow/example_usage.py와 동일한 내용입니다.
examples/ 디렉토리에서도 쉽게 찾을 수 있도록 배치합니다.

Usage:
  export MLFLOW_TRACKING_URI=<CDK output>
  python example_tracking.py
"""
import os

import mlflow

TRACKING_URI = os.environ["MLFLOW_TRACKING_URI"]
mlflow.set_tracking_uri(TRACKING_URI)


def log_rl_training(experiment_name: str, env: str, total_steps: int):
    """RL 학습 메트릭 기록 패턴."""
    mlflow.set_experiment(experiment_name)

    with mlflow.start_run():
        mlflow.log_param("env", env)

        for step in range(0, total_steps, 1000):
            reward = 50.0 + step * 0.01
            mlflow.log_metric("reward", reward, step=step)
            mlflow.log_metric("episode_length", 200, step=step)


def log_vla_training(experiment_name: str, model: str, dataset: str, epochs: int):
    """VLA 학습 메트릭 기록 패턴."""
    mlflow.set_experiment(experiment_name)

    with mlflow.start_run():
        mlflow.log_params({"model": model, "dataset": dataset})

        for epoch in range(epochs):
            loss = 2.0 / (epoch + 1)
            mlflow.log_metric("loss", loss, step=epoch)


if __name__ == "__main__":
    log_rl_training("rl-demo", "Isaac-Cartpole-v0", 10000)
    log_vla_training("vla-demo", "GR00T-N1.6-3B", "aloha", 50)
    print("Done. Check SageMaker Studio > MLflow UI.")
```

- [ ] **Step 4: Commit**

```bash
chmod +x training/hyperpod/mlflow/setup.sh
git add training/hyperpod/mlflow/ training/hyperpod/examples/mlflow/
git commit -m "feat(hyperpod): MLflow 설정 및 사용 예시"
```

---

## Task 15: Researcher Guide

**Files:**
- Create: `training/hyperpod/docs/researcher_guide.md`

- [ ] **Step 1: Create researcher_guide.md**

```markdown
# 리서처 가이드

HyperPod 클러스터에서 VLA/RL 학습을 실행하기 위한 가이드.

## 1. 클러스터 접속

SSM Session Manager로 head-node에 접속한다 (SSH 키 불필요):

\`\`\`bash
# 클러스터 노드 목록 확인
aws sagemaker list-cluster-nodes --cluster-name <cluster-name>

# head-node 접속
aws ssm start-session --target sagemaker-cluster:<cluster-id>_head-0
\`\`\`

## 2. 환경 확인

\`\`\`bash
# 파티션 상태 확인
sinfo

# 예상 출력:
# PARTITION AVAIL NODES STATE
# sim         up     0   idle
# train*      up     0   idle
# debug       up     0   idle

# 스토리지 확인
df -h /fsx

# GPU 확인 (compute 노드에서)
srun --partition=train --gpus=1 nvidia-smi
\`\`\`

## 3. 데이터 업로드

\`\`\`bash
# S3에 데이터셋 업로드
aws s3 cp ./my_dataset/ s3://<bucket>/datasets/groot/my_dataset/ --recursive

# FSx에서 확인 (자동 동기화, 수 초 소요)
ls /fsx/datasets/groot/my_dataset/
\`\`\`

### S3 경로 규칙

| 경로 | 용도 |
|------|------|
| `s3://bucket/datasets/groot/` | GR00T 학습 데이터 (LeRobot v2) |
| `s3://bucket/datasets/pi0/` | π0 학습 데이터 |
| `s3://bucket/checkpoints/rl/` | RL 체크포인트 |
| `s3://bucket/checkpoints/vla/` | VLA 체크포인트 |
| `s3://bucket/mlflow-artifacts/` | MLflow 아티팩트 (자동) |

## 4. VLA 학습 실행

### GR00T Fine-tuning

\`\`\`bash
# 기본 실행
sbatch slurm-templates/vla/finetune_groot.sbatch

# 파라미터 지정
DATASET=aloha EPOCHS=100 sbatch slurm-templates/vla/finetune_groot.sbatch

# 래퍼 스크립트 사용
./slurm-templates/vla/run_vla.sh --model groot --dataset aloha --epochs 50
\`\`\`

### π0 Fine-tuning

\`\`\`bash
./slurm-templates/vla/run_vla.sh --model pi0 --dataset bridge_v2 --epochs 100
\`\`\`

### 멀티노드 학습

\`\`\`bash
# 2노드 (8× L40S 총 GPU)
./slurm-templates/vla/run_vla.sh --model groot --dataset aloha --nodes 2
\`\`\`

## 5. RL 학습 실행

\`\`\`bash
# Actor-Learner 실행 (actor 8개)
./slurm-templates/rl/run_rl.sh --env Isaac-Cartpole-v0 --num-actors 8

# Humanoid 환경, actor 16개
./slurm-templates/rl/run_rl.sh --env Isaac-Humanoid-v0 --num-actors 16
\`\`\`

## 6. DCV 시각화 검증

\`\`\`bash
# DCV 세션 시작
sbatch slurm-templates/debug/dcv_session.sbatch

# 또는 체크포인트 지정하여 바로 검증
CHECKPOINT=/fsx/checkpoints/vla/groot-aloha/model_final.pt \
  sbatch slurm-templates/debug/dcv_session.sbatch
\`\`\`

### DCV 접속

1. 로그에서 접속 정보 확인:
\`\`\`bash
cat /fsx/scratch/logs/dcv-<job_id>.out
\`\`\`

2. SSM 포트포워딩:
\`\`\`bash
aws ssm start-session --target <node-instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8443"],"localPortNumber":["8443"]}'
\`\`\`

3. 브라우저에서 `https://localhost:8443` 접속

## 7. MLflow UI 접속

SageMaker Studio에서 직접 확인:
1. AWS Console → SageMaker → Studio 접속
2. 좌측 메뉴 → MLflow
3. 실험 선택 → 메트릭/아티팩트 확인

또는 코드에서 직접 조회:
\`\`\`python
import mlflow
import os

mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
runs = mlflow.search_runs(experiment_names=["groot-finetune-aloha"])
print(runs[["run_id", "metrics.loss", "status"]])
\`\`\`

## 8. SLURM 자주 쓰는 명령어

| 명령어 | 설명 |
|--------|------|
| `sinfo` | 파티션/노드 상태 |
| `squeue` | 실행 중인 job 목록 |
| `squeue -u $USER` | 내 job만 보기 |
| `sbatch <script>` | job 제출 |
| `scancel <job_id>` | job 취소 |
| `scancel -u $USER` | 내 job 모두 취소 |
| `scontrol show job <id>` | job 상세 정보 |
| `sacct -j <id>` | 완료된 job 정보 |
| `srun --partition=debug --pty bash` | interactive 세션 |

## 9. 트러블슈팅

### Job이 PENDING 상태에서 안 움직임
\`\`\`bash
# 이유 확인
scontrol show job <job_id> | grep Reason
\`\`\`
- `Resources`: 노드 프로비저닝 중 (오토스케일링, 5-10분 소요)
- `Priority`: 다른 job이 먼저 실행 중

### GPU 메모리 부족 (OOM)
- batch_size 줄이기
- gradient checkpointing 활성화
- 멀티노드로 분산

### FSx에 파일이 안 보임
\`\`\`bash
# S3 동기화 강제 수행
lfs hsm_restore /fsx/datasets/path/to/file
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add training/hyperpod/docs/researcher_guide.md
git commit -m "docs(hyperpod): 리서처 가이드 (접속, SLURM, 학습, 검증)"
```

---

## Task 16: Architecture Document

**Files:**
- Create: `training/hyperpod/docs/architecture.md`

- [ ] **Step 1: Create architecture.md**

```markdown
# HyperPod 학습 인프라 아키텍처

## 개요

SageMaker HyperPod 기반 로봇 모델 학습 인프라.
VLA fine-tuning (GR00T, π0)과 IsaacLab RL (Actor-Learner)을 단일 SLURM 클러스터에서 실행한다.

## 클러스터 구성

| 파티션 | 인스턴스 | 최대 | 역할 | 스케일링 |
|--------|---------|------|------|---------|
| head | ml.m5.xlarge | 1 | SLURM controller | 상시 |
| sim | ml.g5.12xlarge (4×L4) | 16 | IsaacLab Actor | Spot, 0→16 |
| train | ml.g6e.12xlarge (4×L40S) | 4 | VLA/RL Learner | OnDemand, 0→4 |
| debug | ml.g5.4xlarge (1×L4) | 1 | DCV 시각화 | OnDemand, 0→1 |

## 스토리지

- **S3**: 데이터셋, 체크포인트, MLflow 아티팩트 (영구 보관)
- **FSx for Lustre**: S3와 자동 동기화, 학습 중 고속 I/O
- **동기화 방향**: S3 → FSx (auto-import), FSx → S3 (auto-export)

## 네트워크

- VPC (Private Subnet) 내 모든 리소스 배치
- NAT Gateway로 외부 접근 (NGC 컨테이너 pull 등)
- S3 VPC Gateway Endpoint (트래픽 비용 절감)
- SageMaker API Interface Endpoint (MLflow 접근)
- 클러스터 SG 자기참조 인그레스 (노드 간 NCCL/Ray 통신)

## 보안

- SSM Session Manager로 접속 (퍼블릭 IP 없음)
- IAM 기반 인증 (별도 SSH 키/패스워드 불필요)
- VPC 내부 통신만 허용 (인터넷 → 클러스터 직접 접근 불가)

## 컨테이너 런타임

- Enroot + Pyxis (NVIDIA 표준)
- NGC 컨테이너를 SLURM job에서 `--container-image` 옵션으로 직접 실행
- lifecycle script에서 자동 설치

## 오토스케일링

SLURM의 Power Saving 기능 활용:
- `SuspendTime=600`: idle 10분 후 노드 종료
- `ResumeTimeout=900`: 노드 시작 최대 15분 대기
- job 제출 시 ResumeProgram이 HyperPod API로 노드 시작

## 비용 최적화

- head-node만 상시 실행 (~$0.19/hr)
- sim 파티션 Spot 인스턴스 (최대 ~70% 할인)
- 오토스케일링으로 idle 비용 제거
- S3 Intelligent-Tiering (30일 이후 자동 전환)

## 멀티유저

CDK context `userId`로 전체 스택 격리:
- 사용자별 VPC + 클러스터 + S3 + FSx + MLflow
- 동일 계정/리전에서 여러 사용자 독립 배포 가능
- `UserId` 태그로 비용 추적
```

- [ ] **Step 2: Commit**

```bash
git add training/hyperpod/docs/architecture.md
git commit -m "docs(hyperpod): 아키텍처 문서"
```

---

## Task 17: Final Integration & Synth Verification

**Files:**
- Modify: `training/hyperpod/cdk/bin/app.ts` (이미 생성됨, 검증만)

- [ ] **Step 1: Install dependencies**

```bash
cd training/hyperpod/cdk && npm install
```

- [ ] **Step 2: Run cdk synth to verify full stack**

```bash
cd training/hyperpod/cdk && npx cdk synth --no-staging 2>&1 | tail -20
```

Expected: CloudFormation template 정상 생성 (Resources 섹션 포함)

- [ ] **Step 3: Verify directory structure**

```bash
find training/hyperpod/ -type f | sort
```

Expected: 모든 파일이 계획대로 생성됨

- [ ] **Step 4: Add .gitignore for CDK**

```
# training/hyperpod/cdk/.gitignore
node_modules/
cdk.out/
*.js
*.d.ts
```

- [ ] **Step 5: Final commit**

```bash
git add training/hyperpod/cdk/.gitignore
git commit -m "chore(hyperpod): CDK .gitignore 추가"
```

---

## Summary

| Task | 내용 | 예상 시간 |
|------|------|----------|
| 1 | CDK 프로젝트 스캐폴딩 | 5분 |
| 2 | Networking Construct | 5분 |
| 3 | Storage Construct | 5분 |
| 4 | HyperPod Cluster Construct | 5분 |
| 5 | MLflow Construct | 3분 |
| 6 | Main Stack (조합) | 5분 |
| 7 | Lifecycle Scripts | 5분 |
| 8 | Cluster Config (수동 가이드) | 5분 |
| 9 | SLURM Templates (RL) | 5분 |
| 10 | SLURM Templates (VLA) | 5분 |
| 11 | SLURM Template (DCV) | 3분 |
| 12 | Example Code (VLA) | 5분 |
| 13 | Example Code (RL) | 5분 |
| 14 | MLflow Setup & Examples | 5분 |
| 15 | Researcher Guide | 5분 |
| 16 | Architecture Doc | 3분 |
| 17 | Integration & Verification | 5분 |

**Total: ~84분**
