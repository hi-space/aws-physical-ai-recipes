import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { Platform } from './web-service';

/** The workflow controller service — separate task from browser request handling. */
export function createControllerService(
  scope: Construct,
  platform: Platform,
  props: { environment: Record<string, string>; userPoolId: string; runtimeSigningSecret: secretsmanager.ISecret; cpu?: number; memoryMiB?: number; dependsOn: ecs.FargateService },
): { role: iam.Role; service: ecs.FargateService } {
  const role = new iam.Role(scope, 'ControllerRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    description: 'Physical AI workflow controller; separate from browser request handling',
  });
  // Publication streams SHA-256 over every exported object before the S3 snapshot copy; CPU bound.
  const controllerTask = new ecs.FargateTaskDefinition(scope, 'ControllerTask', {
    cpu: props.cpu ?? 2048, memoryLimitMiB: props.memoryMiB ?? 4096, taskRole: role,
    runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
  });
  controllerTask.addContainer('controller', {
    image: platform.image,
    command: ['node', '/app/services/controller.cjs'],
    // Key order mirrors the pre-split construct exactly (COGNITO_USER_POOL_ID owned here).
    // The controller never authenticates browsers, so it always runs AUTH_MODE=alb and never
    // receives the cognito login env (COGNITO_APP_CLIENT_ID / SESSION_SIGNING_KEY). In https
    // props.environment already carries 'alb' (buildEnv position 3), so this in-place override is
    // a no-op and the rendered Environment array stays byte-identical; in http it replaces the web
    // tier's 'cognito' without moving the key, so loadConfig does not demand the cognito env here.
    environment: { ...props.environment, AUTH_MODE: 'alb', COGNITO_USER_POOL_ID: props.userPoolId, WORKFLOW_CONTROLLER: '0', NODE_ENV: 'production' },
    secrets: { RUNTIME_SIGNING_KEY: ecs.Secret.fromSecretsManager(props.runtimeSigningSecret, 'key') },
    portMappings: [{ containerPort: 3001 }],
    logging: ecs.LogDrivers.awsLogs({ logGroup: platform.logGroup, streamPrefix: 'controller' }),
    healthCheck: {
      command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3001/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
      interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5), retries: 3, startPeriod: cdk.Duration.seconds(30),
    },
    stopTimeout: cdk.Duration.seconds(90),
  });
  const service = new ecs.FargateService(scope, 'Controller', {
    cluster: platform.cluster, taskDefinition: controllerTask, desiredCount: 1,
    minHealthyPercent: 100, maxHealthyPercent: 200,
    assignPublicIp: false, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [platform.serviceSecurityGroup], circuitBreaker: { rollback: true },
    cloudMapOptions: { name: 'controller' },
  });
  service.node.addDependency(props.dependsOn);
  return { role, service };
}
