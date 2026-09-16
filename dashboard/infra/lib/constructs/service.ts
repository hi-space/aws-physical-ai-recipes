import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface ServiceConstructProps {
  vpc: ec2.IVpc;
  domainName: string;
  hostedZone: route53.IHostedZone;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  userPoolDomain: cognito.IUserPoolDomain;
  /** Environment for the container; ALB_ARN and COGNITO_USER_POOL_ID are added here. */
  environment: Record<string, string>;
  webAppPath: string;
  namePrefix: string;
  cpu?: number;
  memoryMiB?: number;
  runtimeSigningSecret: secretsmanager.ISecret;
}

/**
 * ALB (HTTPS, Cognito auth) → ECS Fargate running the Next.js standalone image.
 * `/api/health` bypasses authentication for the target-group health check.
 */
export class ServiceConstruct extends Construct {
  readonly taskRole: iam.Role;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly service: ecs.FargateService;
  readonly certificate: acm.Certificate;
  readonly logGroup: logs.LogGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly controllerRole: iam.Role;
  readonly controllerService: ecs.FargateService;
  readonly gatewayRole: iam.Role;
  readonly gatewayService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ServiceConstructProps) {
    super(scope, id);

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.apps.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc: props.vpc, description: `${props.namePrefix} ALB`, allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(300), // SSE log streams
      dropInvalidHeaderFields: true,
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.loadBalancer)),
    });
    new route53.ARecord(this, 'AppSessionsRecord', {
      zone: props.hostedZone,
      recordName: `*.apps.${props.domainName}`,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.loadBalancer)),
    });

    // ---- ECS
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc, clusterName: `${props.namePrefix}`, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    cluster.addDefaultCloudMapNamespace({ name: `${props.namePrefix}.internal` });
    this.logGroup = new logs.LogGroup(this, 'Logs', { logGroupName: `/aws/ecs/${props.namePrefix}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${props.namePrefix}-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Physical AI Dashboard application role (EKS access entry principal)',
    });

    const image = ecs.ContainerImage.fromDockerImageAsset(
      new ecrAssets.DockerImageAsset(this, 'Image', {
        directory: props.webAppPath,
        platform: ecrAssets.Platform.LINUX_AMD64,
        exclude: ['node_modules', '.next', 'dist', '*.tsbuildinfo', 'e2e', 'playwright-report', 'test-results'],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: props.cpu ?? 512,
      memoryLimitMiB: props.memoryMiB ?? 1024,
      taskRole: this.taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const container = taskDef.addContainer('web', {
      image,
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'web' }),
      environment: {
        ...props.environment,
        ALB_ARN: this.loadBalancer.loadBalancerArn,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        DASHBOARD_ORIGIN: `https://${props.domainName}`,
        WORKFLOW_CONTROLLER: '0',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
      },
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
    void container;

    const svcSg = new ec2.SecurityGroup(this, 'ServiceSg', { vpc: props.vpc, description: `${props.namePrefix} service`, allowAllOutbound: true });
    this.serviceSecurityGroup = svcSg;
    svcSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'from ALB');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      // The one-time split must stop the legacy in-process controller first.
      minHealthyPercent: this.node.tryGetContext('controllerSplitMigration') === 'true' ? 0 : 100,
      maxHealthyPercent: this.node.tryGetContext('controllerSplitMigration') === 'true' ? 100 : 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [svcSg],
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
    });

    this.controllerRole = new iam.Role(this, 'ControllerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Physical AI workflow controller; separate from browser request handling',
    });
    const controllerTask = new ecs.FargateTaskDefinition(this, 'ControllerTask', {
      cpu: 512, memoryLimitMiB: 1024, taskRole: this.controllerRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    controllerTask.addContainer('controller', {
      image,
      command: ['node', '/app/services/controller.cjs'],
      environment: { ...props.environment, COGNITO_USER_POOL_ID: props.userPool.userPoolId, WORKFLOW_CONTROLLER: '0', AUTH_MODE: 'alb', NODE_ENV: 'production' },
      secrets: { RUNTIME_SIGNING_KEY: ecs.Secret.fromSecretsManager(props.runtimeSigningSecret, 'key') },
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'controller' }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3001/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5), retries: 3, startPeriod: cdk.Duration.seconds(30),
      },
      stopTimeout: cdk.Duration.seconds(90),
    });
    this.controllerService = new ecs.FargateService(this, 'Controller', {
      cluster, taskDefinition: controllerTask, desiredCount: 1,
      minHealthyPercent: 100, maxHealthyPercent: 200,
      assignPublicIp: false, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [svcSg], circuitBreaker: { rollback: true },
      cloudMapOptions: { name: 'controller' },
    });
    this.controllerService.node.addDependency(this.service);
    this.gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Physical AI authenticated session transport',
    });
    const gatewayTask = new ecs.FargateTaskDefinition(this, 'GatewayTask', {
      cpu: 256, memoryLimitMiB: 512, taskRole: this.gatewayRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    gatewayTask.addContainer('gateway', {
      image, command: ['node', '/app/services/gateway.cjs'],
      environment: {
        ...props.environment, AUTH_MODE: 'alb', WORKFLOW_CONTROLLER: '0',
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        DASHBOARD_ORIGIN: `https://${props.domainName}`, GATEWAY_BASE_DOMAIN: `apps.${props.domainName}`,
        GATEWAY_ASSET_DIR: '/app/services/gateway-assets',
      },
      portMappings: [{ containerPort: 3002 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'gateway' }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3002/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5), retries: 3, startPeriod: cdk.Duration.seconds(30),
      },
    });
    svcSg.addIngressRule(albSg, ec2.Port.tcp(3002), 'Authenticated session hosts from ALB');
    this.gatewayService = new ecs.FargateService(this, 'Gateway', {
      cluster, taskDefinition: gatewayTask, desiredCount: 1,
      minHealthyPercent: 100, maxHealthyPercent: 200,
      assignPublicIp: false, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [svcSg], circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Tg', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(10),
      healthCheck: { path: '/api/health', interval: cdk.Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3, timeout: cdk.Duration.seconds(5) },
      targets: [this.service],
    });

    const https = this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [this.certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: new actions.AuthenticateCognitoAction({
        userPool: props.userPool,
        userPoolClient: props.userPoolClient,
        userPoolDomain: props.userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
        sessionTimeout: cdk.Duration.hours(12),
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
      }),
    });
    https.addAction('Health', { priority: 1, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/health'])], action: elbv2.ListenerAction.forward([targetGroup]) });
    https.addAction('Logout', { priority: 2, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/logout'])], action: elbv2.ListenerAction.forward([targetGroup]) });
    https.addAction('ApiTokens', { priority: 3, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/v1/*'])], action: elbv2.ListenerAction.forward([targetGroup]) });
    https.addTargets('SessionHosts', {
      priority: 5,
      conditions: [elbv2.ListenerCondition.hostHeaders([`*.apps.${props.domainName}`])],
      port: 3002, protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.gatewayService],
      healthCheck: { path: '/health', healthyThresholdCount: 2, interval: cdk.Duration.seconds(15) },
      deregistrationDelay: cdk.Duration.seconds(15),
    });
    this.loadBalancer.addListener('Http', { port: 80, defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }) });

    // The ALB must be able to reach Cognito (token endpoint) — allowAllOutbound covers it.
  }
}
