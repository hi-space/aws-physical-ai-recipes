import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface Platform {
  cluster: ecs.Cluster;
  logGroup: logs.LogGroup;
  image: ecs.ContainerImage;
  serviceSecurityGroup: ec2.SecurityGroup;
  /** Kept so gateway-service can open its own ALB→3002 ingress rule with the original logical id. */
  albSg: ec2.ISecurityGroup;
}

/** Cluster, log group, web image asset and the shared service security group (with ALB→3000 ingress). */
export function createPlatform(scope: Construct, props: { vpc: ec2.IVpc; namePrefix: string; webAppPath: string; albSg: ec2.ISecurityGroup }): Platform {
  const cluster = new ecs.Cluster(scope, 'Cluster', { vpc: props.vpc, clusterName: `${props.namePrefix}`, containerInsightsV2: ecs.ContainerInsights.ENABLED });
  cluster.addDefaultCloudMapNamespace({ name: `${props.namePrefix}.internal` });
  const logGroup = new logs.LogGroup(scope, 'Logs', { logGroupName: `/aws/ecs/${props.namePrefix}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

  const image = ecs.ContainerImage.fromDockerImageAsset(
    new ecrAssets.DockerImageAsset(scope, 'Image', {
      directory: props.webAppPath,
      platform: ecrAssets.Platform.LINUX_AMD64,
      exclude: ['node_modules', '.next', 'dist', '*.tsbuildinfo', 'next-env.d.ts', '.env*', '.results', 'e2e', 'playwright-report', 'test-results'],
    }),
  );

  const serviceSecurityGroup = new ec2.SecurityGroup(scope, 'ServiceSg', { vpc: props.vpc, description: `${props.namePrefix} service`, allowAllOutbound: true });
  serviceSecurityGroup.addIngressRule(props.albSg, ec2.Port.tcp(3000), 'from ALB');

  return { cluster, logGroup, image, serviceSecurityGroup, albSg: props.albSg };
}

/** Application task role — the EKS access-entry principal. */
export function createTaskRole(scope: Construct, namePrefix: string): iam.Role {
  return new iam.Role(scope, 'TaskRole', {
    roleName: `${namePrefix}-task`,
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    description: 'Physical AI Dashboard application role (EKS access entry principal)',
  });
}

/** The Next.js standalone web service on Fargate. */
export function createWebService(scope: Construct, platform: Platform, props: { environment: Record<string, string>; taskRole: iam.Role; cpu?: number; memoryMiB?: number; secrets?: Record<string, ecs.Secret> }): ecs.FargateService {
  const taskDef = new ecs.FargateTaskDefinition(scope, 'TaskDef', {
    cpu: props.cpu ?? 512,
    memoryLimitMiB: props.memoryMiB ?? 1024,
    taskRole: props.taskRole,
    runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
  });
  taskDef.addContainer('web', {
    image: platform.image,
    logging: ecs.LogDrivers.awsLogs({ logGroup: platform.logGroup, streamPrefix: 'web' }),
    environment: {
      ...props.environment,
      WORKFLOW_CONTROLLER: '0',
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
    },
    ...(props.secrets ? { secrets: props.secrets } : {}),
    portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    healthCheck: {
      command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3000/api/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(30),
    },
    stopTimeout: cdk.Duration.seconds(30),
  });

  return new ecs.FargateService(scope, 'Service', {
    cluster: platform.cluster,
    taskDefinition: taskDef,
    desiredCount: 1,
    // The one-time split must stop the legacy in-process controller first.
    minHealthyPercent: scope.node.tryGetContext('controllerSplitMigration') === 'true' ? 0 : 100,
    maxHealthyPercent: scope.node.tryGetContext('controllerSplitMigration') === 'true' ? 100 : 200,
    assignPublicIp: false,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [platform.serviceSecurityGroup],
    enableExecuteCommand: true,
    circuitBreaker: { rollback: true },
    healthCheckGracePeriod: cdk.Duration.seconds(90),
  });
}
