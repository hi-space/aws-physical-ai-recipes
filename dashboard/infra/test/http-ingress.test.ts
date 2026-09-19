import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from 'aws-cdk-lib/assertions';
import { synthesize } from './helpers/synth';
import { resolveModules } from '../lib/modules';
const http = (ctx: Record<string, string | undefined> = {}) =>
  synthesize({ modules: resolveModules(k => ctx[k]), domainName: '', hostedZoneId: '', hostedZoneName: '' });

test('http ingress has one :80 listener forwarding to web, no certificate, no DNS, no Cognito action', () => {
  // gateway=false isolates the base http ingress; the :8080 gateway listener is asserted separately below.
  const t = http({ gateway: 'false' });
  t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  t.resourceCountIs('AWS::Route53::RecordSet', 0);
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({ Port: 80, Protocol: 'HTTP' }));
  assert.ok(!JSON.stringify(t.toJSON()).includes('AuthenticateCognitoConfig'));
});
test('http ingress creates a secret-less app client with password + SRP flows and injects AUTH_MODE=cognito', () => {
  const t = http();
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'app', GenerateSecret: false,
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']) }));
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('"Name":"AUTH_MODE","Value":"cognito"'));
  assert.ok(text.includes('COGNITO_APP_CLIENT_ID'));
  assert.ok(text.includes('SESSION_SIGNING_KEY'));
  // In http mode there is exactly one user-pool client (the secret-less app client); no ALB client/branding.
  t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'app' }));
});
test('the app client is InitiateAuth-only: no OAuth flows, scopes or callbacks', () => {
  const t = http();
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({
    ClientName: 'app',
    AllowedOAuthFlows: Match.absent(),
    AllowedOAuthScopes: Match.absent(),
    CallbackURLs: Match.absent(),
  }));
  // disableOAuth renders AllowedOAuthFlowsUserPoolClient as false (never true).
  const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0] as { Properties: { AllowedOAuthFlowsUserPoolClient?: boolean } };
  assert.notEqual(client.Properties.AllowedOAuthFlowsUserPoolClient, true);
});
test('http ingress with gateway adds a :8080 listener to the gateway service and injects GATEWAY_MODE=path', () => {
  const t = http(); // gateway 기본 true
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({ Port: 8080, Protocol: 'HTTP' }));
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('"Name":"GATEWAY_MODE","Value":"path"'));
  assert.ok(text.includes('GATEWAY_PUBLIC_ORIGIN'));
  assert.ok(!text.includes('GATEWAY_BASE_DOMAIN'));
});
test('http ingress with gateway runs three ECS services and a :8080 target group on 3002 with a /health check', () => {
  const t = http();
  t.resourceCountIs('AWS::ECS::Service', 3); // web + controller + gateway
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', Match.objectLike({
    Port: 3002, Protocol: 'HTTP', TargetType: 'ip', HealthCheckPath: '/health',
  }));
  // path mode never uses host-header routing; there is no *.apps target rule.
  const rules = t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.ok(!Object.values(rules).some(r => JSON.stringify(r).includes('*.apps.')), 'no gateway host-header rule');
});
test('http ingress opens the ALB security group on 80 and 8080 only', () => {
  const t = http();
  const albSg = Object.values(t.findResources('AWS::EC2::SecurityGroup'))
    .find(r => String((r as { Properties?: { GroupDescription?: string } }).Properties?.GroupDescription ?? '').includes('ALB')) as
      { Properties: { SecurityGroupIngress?: { FromPort: number }[] } };
  const ports = (albSg.Properties.SecurityGroupIngress ?? []).map(r => r.FromPort).sort((a, b) => a - b);
  assert.deepEqual(ports, [80, 8080]);
});
test('http ingress with gateway=false keeps a single :80 listener, two services and no GATEWAY_MODE', () => {
  const t = http({ gateway: 'false' });
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  t.resourceCountIs('AWS::ECS::Service', 2); // web + controller, no gateway
  const text = JSON.stringify(t.toJSON());
  assert.ok(!text.includes('GATEWAY_MODE'), 'no gateway env when gateway module is off');
  assert.ok(!text.includes('GATEWAY_BASE_DOMAIN'), 'no gateway env');
});
test('https ingress still has the ALB client and no app client env', () => {
  const t = synthesize();
  assert.ok(!JSON.stringify(t.toJSON()).includes('"Name":"AUTH_MODE","Value":"cognito"'));
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'alb' }));
});

type ContainerDef = { Name: string; Environment?: { Name: string; Value: unknown }[]; Secrets?: { Name: string; ValueFrom: unknown }[] };
const containers = (t: ReturnType<typeof http>): ContainerDef[] =>
  Object.values(t.findResources('AWS::ECS::TaskDefinition')).flatMap(r => (r as { Properties: { ContainerDefinitions: ContainerDef[] } }).Properties.ContainerDefinitions);
const byName = (t: ReturnType<typeof http>, name: string) => containers(t).find(c => c.Name === name)!;
const envValue = (c: ContainerDef, key: string) => (c.Environment ?? []).find(e => e.Name === key)?.Value;
const hasEnv = (c: ContainerDef, key: string) => (c.Environment ?? []).some(e => e.Name === key);
const hasSecret = (c: ContainerDef, key: string) => (c.Secrets ?? []).some(s => s.Name === key);

test('http mode: the controller keeps AUTH_MODE=alb and never gets the cognito login env, while the web tier is AUTH_MODE=cognito', () => {
  const t = http();
  const controller = byName(t, 'controller');
  assert.equal(envValue(controller, 'AUTH_MODE'), 'alb');
  assert.ok(!hasEnv(controller, 'COGNITO_APP_CLIENT_ID'), 'controller must not carry COGNITO_APP_CLIENT_ID');
  assert.ok(!hasSecret(controller, 'SESSION_SIGNING_KEY'), 'controller must not carry the SESSION_SIGNING_KEY secret');
  const web = byName(t, 'web');
  assert.equal(envValue(web, 'AUTH_MODE'), 'cognito');
  assert.ok(hasEnv(web, 'COGNITO_APP_CLIENT_ID'), 'web must carry COGNITO_APP_CLIENT_ID');
  assert.ok(hasSecret(web, 'SESSION_SIGNING_KEY'), 'web must carry the SESSION_SIGNING_KEY secret');
});

test('http mode: the gateway container runs AUTH_MODE=alb with GATEWAY_MODE=path, GATEWAY_PUBLIC_ORIGIN (:8080) and DASHBOARD_ORIGIN, no GATEWAY_BASE_DOMAIN', () => {
  const t = http();
  const gateway = byName(t, 'gateway');
  assert.equal(envValue(gateway, 'AUTH_MODE'), 'alb');
  assert.equal(envValue(gateway, 'GATEWAY_MODE'), 'path');
  assert.ok(hasEnv(gateway, 'GATEWAY_PUBLIC_ORIGIN'), 'gateway must carry GATEWAY_PUBLIC_ORIGIN');
  assert.ok(hasEnv(gateway, 'DASHBOARD_ORIGIN'), 'gateway must carry DASHBOARD_ORIGIN for the ticket-exchange origin check');
  assert.ok(!hasEnv(gateway, 'GATEWAY_BASE_DOMAIN'), 'gateway must not carry GATEWAY_BASE_DOMAIN in http mode');
  assert.ok(!hasEnv(gateway, 'COGNITO_APP_CLIENT_ID'), 'gateway must not carry COGNITO_APP_CLIENT_ID');
  // GATEWAY_PUBLIC_ORIGIN is a CloudFormation join over the ALB DNS name → http://<alb>:8080.
  const origin = JSON.stringify(envValue(gateway, 'GATEWAY_PUBLIC_ORIGIN'));
  assert.ok(origin.includes('http://'), 'origin scheme is http://');
  assert.ok(origin.includes(':8080'), 'origin port is :8080');
});

test('invariant: any container running AUTH_MODE=cognito also carries COGNITO_APP_CLIENT_ID and the SESSION_SIGNING_KEY secret (http and https)', () => {
  for (const t of [http(), synthesize()]) {
    for (const c of containers(t)) {
      if (envValue(c, 'AUTH_MODE') !== 'cognito') continue;
      assert.ok(hasEnv(c, 'COGNITO_APP_CLIENT_ID'), `${c.Name}: cognito container is missing COGNITO_APP_CLIENT_ID`);
      assert.ok(hasSecret(c, 'SESSION_SIGNING_KEY'), `${c.Name}: cognito container is missing the SESSION_SIGNING_KEY secret`);
    }
  }
});
