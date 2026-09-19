import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { DashboardModules } from '../modules';

export interface IngressProps {
  vpc: ec2.IVpc;
  namePrefix: string;
  mode: DashboardModules['ingress'];
  hostedZone?: route53.IHostedZone;
  auth?: { userPool: cognito.IUserPool; userPoolClient: cognito.IUserPoolClient; userPoolDomain: cognito.IUserPoolDomain };
  waf: boolean;
  gateway: boolean;
}

export interface Ingress {
  loadBalancer: elbv2.ApplicationLoadBalancer;
  albSg: ec2.SecurityGroup;
  certificate?: acm.Certificate;
  webAcl?: wafv2.CfnWebACL;
  accessLogs: s3.Bucket;
  /** The HTTPS listener; populated by attachWeb (the default action forwards to the web target group). */
  listener: elbv2.ApplicationListener;
  attachWeb(service: ecs.FargateService): elbv2.ApplicationTargetGroup;
  attachGateway(service: ecs.FargateService): void;
}

/**
 * ALB + TLS + Route 53 + WAF + access logs. Resources are created directly on the
 * `ServiceConstruct` scope with their original child ids so logical ids are unchanged.
 */
export function createIngress(scope: Construct, props: IngressProps): Ingress {
  const isHttp = props.mode.mode === 'http';
  const domainName = props.mode.mode === 'https' ? props.mode.domainName : undefined;

  const albSg = new ec2.SecurityGroup(scope, 'AlbSg', { vpc: props.vpc, description: `${props.namePrefix} ALB`, allowAllOutbound: true });
  if (isHttp) {
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
  } else {
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');
  }

  const loadBalancer = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
    vpc: props.vpc,
    internetFacing: true,
    securityGroup: albSg,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    idleTimeout: cdk.Duration.seconds(300), // SSE log streams
    dropInvalidHeaderFields: true,
  });

  // TLS certificate + Route 53 alias records are https-only; http mode is reached over the raw ALB DNS name.
  let certificate: acm.Certificate | undefined;
  if (!isHttp) {
    certificate = new acm.Certificate(scope, 'Certificate', {
      domainName: domainName!,
      subjectAlternativeNames: props.gateway ? [`*.apps.${domainName}`] : undefined,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    new route53.ARecord(scope, 'AliasRecord', {
      zone: props.hostedZone!,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
    });
    if (props.gateway) {
      new route53.ARecord(scope, 'AppSessionsRecord', {
        zone: props.hostedZone!,
        recordName: `*.apps.${domainName}`,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
      });
    }
  }

  // ---- Edge protection: access logs always; WAF only when enabled.
  const accessLogs = new s3.Bucket(scope, 'AccessLogs', {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  loadBalancer.logAccessLogs(accessLogs, 'alb');

  let webAcl: wafv2.CfnWebACL | undefined;
  if (props.waf) {
    const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName });
    const managed = (name: string, priority: number, overrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[]): wafv2.CfnWebACL.RuleProperty => ({
      name, priority, overrideAction: { none: {} }, visibilityConfig: visibility(name),
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ...(overrides ? { ruleActionOverrides: overrides } : {}) } },
    });
    webAcl = new wafv2.CfnWebACL(scope, 'WebAcl', {
      name: `${props.namePrefix}-web`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${props.namePrefix}-web`),
      rules: [
        // Workflow YAML submissions and session transports legitimately exceed the 8 KB body rule; browser uploads go to S3 directly.
        managed('AWSManagedRulesCommonRuleSet', 10, [{ name: 'SizeRestrictions_BODY', actionToUse: { count: {} } }]),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
        {
          name: 'RateLimitPerIp', priority: 30, action: { block: {} }, visibilityConfig: visibility('RateLimitPerIp'),
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(scope, 'WebAclAssociation', { resourceArn: loadBalancer.loadBalancerArn, webAclArn: webAcl.attrArn });
  }

  let listener: elbv2.ApplicationListener | undefined;

  return {
    loadBalancer,
    albSg,
    certificate,
    webAcl,
    accessLogs,
    get listener() {
      if (!listener) throw new Error('attachWeb must run before the HTTPS listener is available');
      return listener;
    },
    attachWeb(service: ecs.FargateService): elbv2.ApplicationTargetGroup {
      const targetGroup = new elbv2.ApplicationTargetGroup(scope, 'Tg', {
        vpc: props.vpc,
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(10),
        healthCheck: { path: '/api/health', interval: cdk.Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3, timeout: cdk.Duration.seconds(5) },
        targets: [service],
      });

      if (isHttp) {
        // No TLS, no Cognito action, no 80→443 redirect: a single :80 listener forwards to web.
        // In-app Cognito login (AUTH_MODE=cognito) authenticates inside the app, not at the edge.
        listener = loadBalancer.addListener('Http', { port: 80, defaultAction: elbv2.ListenerAction.forward([targetGroup]) });
        return targetGroup;
      }

      const auth = props.auth!;
      const https = loadBalancer.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate!],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultAction: new actions.AuthenticateCognitoAction({
          userPool: auth.userPool,
          userPoolClient: auth.userPoolClient,
          userPoolDomain: auth.userPoolDomain,
          next: elbv2.ListenerAction.forward([targetGroup]),
          sessionTimeout: cdk.Duration.hours(12),
          onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        }),
      });
      https.addAction('Health', { priority: 1, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/health'])], action: elbv2.ListenerAction.forward([targetGroup]) });
      https.addAction('Logout', { priority: 2, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/logout'])], action: elbv2.ListenerAction.forward([targetGroup]) });
      https.addAction('ApiTokens', { priority: 3, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/v1/*'])], action: elbv2.ListenerAction.forward([targetGroup]) });
      loadBalancer.addListener('Http', { port: 80, defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }) });
      // The ALB must be able to reach Cognito (token endpoint) — allowAllOutbound covers it.
      listener = https;
      return targetGroup;
    },
    attachGateway(service: ecs.FargateService): void {
      if (isHttp) {
        // Path mode: no wildcard cert/DNS, so the gateway gets its own :8080 listener instead of
        // host-header routing. The web app rewrites session URLs to http://<alb>:8080/s/<id>/….
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'HTTP session gateway');
        loadBalancer.addListener('GatewayHttp', {
          port: 8080,
          protocol: elbv2.ApplicationProtocol.HTTP,
          defaultAction: elbv2.ListenerAction.forward([
            new elbv2.ApplicationTargetGroup(scope, 'GatewayTg', {
              vpc: props.vpc,
              port: 3002,
              protocol: elbv2.ApplicationProtocol.HTTP,
              targetType: elbv2.TargetType.IP,
              targets: [service],
              deregistrationDelay: cdk.Duration.seconds(15),
              healthCheck: { path: '/health', healthyThresholdCount: 2, interval: cdk.Duration.seconds(15) },
            }),
          ]),
        });
        return;
      }
      if (!listener) throw new Error('attachWeb must run before attachGateway');
      listener.addTargets('SessionHosts', {
        priority: 5,
        conditions: [elbv2.ListenerCondition.hostHeaders([`*.apps.${domainName}`])],
        port: 3002, protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: { path: '/health', healthyThresholdCount: 2, interval: cdk.Duration.seconds(15) },
        deregistrationDelay: cdk.Duration.seconds(15),
      });
    },
  };
}
