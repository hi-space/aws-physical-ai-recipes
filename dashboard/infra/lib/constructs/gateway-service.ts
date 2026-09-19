import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { Platform } from './web-service';

/**
 * The authenticated session-transport gateway service.
 *
 * - https: host-based routing `*.apps.<domain>` on the shared :443 listener (wildcard TLS + DNS).
 * - http (path mode): its own ALB :8080 listener; the web app rewrites session URLs to `/s/<id>/…`.
 *   No wildcard cert or DNS exists, so DASHBOARD_ORIGIN/GATEWAY_PUBLIC_ORIGIN are the raw ALB DNS
 *   name and there is no GATEWAY_BASE_DOMAIN. The gateway authenticates via tickets/grants (never the
 *   Cognito cookie), so it runs AUTH_MODE=alb — set in place like the controller — and never receives
 *   the cognito login env.
 */
export type GatewayServiceProps =
  { environment: Record<string, string>; userPoolId: string } & (
    | { mode: 'https'; domainName: string }
    | { mode: 'http'; dashboardOrigin: string; publicOrigin: string }
  );

export function createGatewayService(
  scope: Construct,
  platform: Platform,
  props: GatewayServiceProps,
): { role: iam.Role; service: ecs.FargateService } {
  const role = new iam.Role(scope, 'GatewayRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    description: 'Physical AI authenticated session transport',
  });
  const gatewayTask = new ecs.FargateTaskDefinition(scope, 'GatewayTask', {
    cpu: 256, memoryLimitMiB: 512, taskRole: role,
    runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
  });
  // Key order mirrors the pre-split construct exactly so the rendered Environment array
  // (CloudFormation-ordered) is unchanged in https: COGNITO_USER_POOL_ID is owned here, not
  // pre-injected by the caller. The https literal is kept byte-identical; http is a separate branch.
  const environment = props.mode === 'https'
    ? {
        ...props.environment, WORKFLOW_CONTROLLER: '0',
        COGNITO_USER_POOL_ID: props.userPoolId,
        DASHBOARD_ORIGIN: `https://${props.domainName}`, GATEWAY_BASE_DOMAIN: `apps.${props.domainName}`,
        GATEWAY_ASSET_DIR: '/app/services/gateway-assets',
      }
    : {
        ...props.environment, WORKFLOW_CONTROLLER: '0',
        COGNITO_USER_POOL_ID: props.userPoolId, AUTH_MODE: 'alb',
        DASHBOARD_ORIGIN: props.dashboardOrigin,
        GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: props.publicOrigin,
        GATEWAY_ASSET_DIR: '/app/services/gateway-assets',
      };
  gatewayTask.addContainer('gateway', {
    image: platform.image, command: ['node', '/app/services/gateway.cjs'],
    environment,
    portMappings: [{ containerPort: 3002 }],
    logging: ecs.LogDrivers.awsLogs({ logGroup: platform.logGroup, streamPrefix: 'gateway' }),
    healthCheck: {
      command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3002/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
      interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5), retries: 3, startPeriod: cdk.Duration.seconds(30),
    },
  });
  platform.serviceSecurityGroup.addIngressRule(platform.albSg, ec2.Port.tcp(3002), 'Authenticated session hosts from ALB');
  const service = new ecs.FargateService(scope, 'Gateway', {
    cluster: platform.cluster, taskDefinition: gatewayTask, desiredCount: 1,
    minHealthyPercent: 100, maxHealthyPercent: 200,
    assignPublicIp: false, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [platform.serviceSecurityGroup], circuitBreaker: { rollback: true },
    healthCheckGracePeriod: cdk.Duration.seconds(60),
  });
  return { role, service };
}
