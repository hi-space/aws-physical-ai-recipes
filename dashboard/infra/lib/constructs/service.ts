import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { DashboardModules } from '../modules';
import { createIngress } from './ingress';
import { createPlatform, createTaskRole, createWebService } from './web-service';
import { createControllerService } from './controller-service';
import { createGatewayService } from './gateway-service';

export interface ServiceConstructProps {
  vpc: ec2.IVpc;
  namePrefix: string;
  webAppPath: string;
  /** Environment for the containers; ALB_ARN and COGNITO_* are added here. */
  environment: Record<string, string>;
  modules: Pick<DashboardModules, 'ingress' | 'gateway' | 'waf'>;
  hostedZone?: route53.IHostedZone;
  userPool: cognito.IUserPool;
  /** ALB authenticate-cognito client; present in https mode only. */
  userPoolClient?: cognito.IUserPoolClient;
  userPoolDomain: cognito.IUserPoolDomain;
  /** Secret-less app client for the web app's in-app Cognito login (http mode). */
  appClient?: cognito.IUserPoolClient;
  runtimeSigningSecret: secretsmanager.ISecret;
  /** Session-cookie signing key for AUTH_MODE=cognito; injected into the web container (http mode). */
  sessionSigningSecret?: secretsmanager.ISecret;
  cpu?: number;
  memoryMiB?: number;
  controllerCpu?: number;
  controllerMemoryMiB?: number;
}

/**
 * ALB (HTTPS, Cognito auth) → ECS Fargate running the Next.js standalone image,
 * plus the workflow controller and (optionally) the authenticated session gateway.
 * Composed from ingress/web/controller/gateway function modules that create every
 * resource on this construct's scope with the original child ids, so the deployed
 * stack's CloudFormation logical ids are unchanged.
 * `/api/health` bypasses authentication for the target-group health check.
 */
export class ServiceConstruct extends Construct {
  readonly taskRole: iam.Role;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly service: ecs.FargateService;
  readonly certificate?: acm.Certificate;
  readonly logGroup: logs.LogGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly controllerRole: iam.Role;
  readonly controllerService: ecs.FargateService;
  readonly gatewayRole?: iam.Role;
  readonly gatewayService?: ecs.FargateService;
  readonly webAcl?: wafv2.CfnWebACL;
  readonly accessLogs: s3.Bucket;

  constructor(scope: Construct, id: string, props: ServiceConstructProps) {
    super(scope, id);

    const isHttp = props.modules.ingress.mode === 'http';
    const ingress = createIngress(this, {
      vpc: props.vpc, namePrefix: props.namePrefix, mode: props.modules.ingress, hostedZone: props.hostedZone,
      auth: isHttp ? undefined : { userPool: props.userPool, userPoolClient: props.userPoolClient!, userPoolDomain: props.userPoolDomain },
      waf: props.modules.waf, gateway: props.modules.gateway,
    });
    const domainName = props.modules.ingress.mode === 'https' ? props.modules.ingress.domainName : undefined;

    // http path mode: the gateway is exposed on ALB :8080 and the web/controller/gateway containers
    // learn its public origin so they can rewrite session URLs to http://<alb>:8080/s/<id>/…. https
    // keeps host-based routing (GATEWAY_BASE_DOMAIN), so these vars are http-only and empty otherwise —
    // that keeps the default https template byte-identical.
    const albDns = ingress.loadBalancer.loadBalancerDnsName;
    const gatewayHttp = isHttp && props.modules.gateway;
    const pathGatewayEnv: Record<string, string> = gatewayHttp ? { GATEWAY_MODE: 'path', GATEWAY_PUBLIC_ORIGIN: `http://${albDns}:8080` } : {};

    const platform = createPlatform(this, { vpc: props.vpc, namePrefix: props.namePrefix, webAppPath: props.webAppPath, albSg: ingress.albSg });
    this.taskRole = createTaskRole(this, props.namePrefix);

    // http: in-app Cognito login — the app client id + a session signing key, DASHBOARD_ORIGIN over the ALB DNS,
    // no ALB_ARN / hosted-UI domain / confidential client. https: unchanged ALB authenticate-cognito wiring.
    const shared = isHttp ? {
      ...props.environment,
      COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      COGNITO_APP_CLIENT_ID: props.appClient!.userPoolClientId,
      DASHBOARD_ORIGIN: `http://${albDns}`,
      ...pathGatewayEnv,
    } : {
      ...props.environment,
      ALB_ARN: ingress.loadBalancer.loadBalancerArn,
      COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClient!.userPoolClientId,
      COGNITO_DOMAIN: `${props.userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
      DASHBOARD_ORIGIN: `https://${domainName}`,
    };
    this.service = createWebService(this, platform, {
      environment: shared, taskRole: this.taskRole, cpu: props.cpu, memoryMiB: props.memoryMiB,
      secrets: isHttp ? { SESSION_SIGNING_KEY: ecs.Secret.fromSecretsManager(props.sessionSigningSecret!, 'key') } : undefined,
    });
    ingress.attachWeb(this.service);

    const controller = createControllerService(this, platform, {
      environment: gatewayHttp ? { ...props.environment, ...pathGatewayEnv } : props.environment, userPoolId: props.userPool.userPoolId,
      runtimeSigningSecret: props.runtimeSigningSecret, cpu: props.controllerCpu, memoryMiB: props.controllerMemoryMiB, dependsOn: this.service,
    });
    this.controllerRole = controller.role;
    this.controllerService = controller.service;

    if (props.modules.gateway) {
      // https: host-based `*.apps.<domain>` routing on the shared :443 listener.
      // http: path mode over the ALB DNS name — its own :8080 listener, no wildcard cert/DNS.
      const gateway = createGatewayService(this, platform, isHttp
        ? { mode: 'http', environment: props.environment, userPoolId: props.userPool.userPoolId,
            dashboardOrigin: `http://${albDns}`, publicOrigin: `http://${albDns}:8080` }
        : { mode: 'https', environment: props.environment, userPoolId: props.userPool.userPoolId, domainName: domainName! });
      this.gatewayRole = gateway.role;
      this.gatewayService = gateway.service;
      ingress.attachGateway(gateway.service);
    }

    this.loadBalancer = ingress.loadBalancer;
    this.certificate = ingress.certificate;
    this.webAcl = ingress.webAcl;
    this.accessLogs = ingress.accessLogs;
    this.logGroup = platform.logGroup;
    this.serviceSecurityGroup = platform.serviceSecurityGroup;
  }
}
