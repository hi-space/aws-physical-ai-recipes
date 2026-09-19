import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from 'aws-cdk-lib/assertions';
import { synthesize } from './helpers/synth';
import { resolveModules } from '../lib/modules';
const domain = { domainName: 'dashboard.example.com', hostedZoneId: 'Z0123456789ABCDEF', hostedZoneName: 'example.com' };
const modules = (extra: Record<string, unknown>) => resolveModules(k => ({ ...domain, ...extra } as Record<string, unknown>)[k]);

test('gateway=false removes the gateway service, its listener rule, the wildcard record and GATEWAY_BASE_DOMAIN', () => {
  const t = synthesize({ modules: modules({ gateway: 'false' }) });
  t.resourceCountIs('AWS::ECS::Service', 2);
  t.resourceCountIs('AWS::Route53::RecordSet', 1);
  const rules = t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.ok(!Object.values(rules).some(r => JSON.stringify(r).includes('*.apps.')));
  const cert = Object.values(t.findResources('AWS::CertificateManager::Certificate'))[0] as { Properties: { SubjectAlternativeNames?: string[] } };
  assert.equal(cert.Properties.SubjectAlternativeNames, undefined);
  assert.ok(!JSON.stringify(t.toJSON()).includes('GATEWAY_BASE_DOMAIN'));
});
test('waf=false removes the web ACL and the WAF alarm; alarms=false removes every alarm', () => {
  const noWaf = synthesize({ modules: modules({ waf: 'false' }) });
  noWaf.resourceCountIs('AWS::WAFv2::WebACL', 0);
  noWaf.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  synthesize({ modules: modules({ alarms: 'false' }) }).resourceCountIs('AWS::CloudWatch::Alarm', 0);
});
test('sourceBuild=false removes the CodeBuild project, ECR repository and build env', () => {
  const t = synthesize({ modules: modules({ sourceBuild: 'false' }) });
  t.resourceCountIs('AWS::CodeBuild::Project', 0);
  t.resourceCountIs('AWS::ECR::Repository', 0);
  const env = JSON.stringify(t.toJSON());
  assert.ok(env.includes('"SOURCE_BUILD_TARGETS_JSON","Value":"[]"'));
});
test('edge=false omits Greengrass env and IAM', () => {
  const t = synthesize({ modules: modules({ edge: 'false' }) });
  const text = JSON.stringify(t.toJSON());
  assert.ok(!text.includes('GREENGRASS_THING_GROUP'));
  assert.ok(!text.includes('greengrass:CreateDeployment'));
});
test('images=mujoco builds one model image plus nothing else and leaves other *_IMAGE_URI unset', () => {
  const t = synthesize({ modules: modules({ images: 'mujoco' }) });
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('MUJOCO_IMAGE_URI'));
  assert.ok(!text.includes('ISAACLAB_IMAGE_URI') && !text.includes('WORKSPACE_IMAGE_URI'));
});
test('the resource tag is applied to taggable resources', () => {
  const t = synthesize({ modules: modules({}) });
  t.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({ Tags: Match.arrayWith([{ Key: 'PhysicalAI', Value: 'true' }]) }));
});
test('the web task role may list tagged resources', () => {
  const t = synthesize({ modules: modules({}) });
  assert.ok(JSON.stringify(t.toJSON()).includes('"tag:GetResources"'));
});
test('http ingress synthesizes in AUTH_MODE=cognito (sub-project E)', () => {
  // gateway=false isolates the base http ingress (single :80 web listener); the :8080 gateway listener is covered in http-ingress.test.ts.
  const t = synthesize({ modules: resolveModules(k => (k === 'gateway' ? 'false' : undefined)), domainName: '', hostedZoneId: '', hostedZoneName: '' });
  assert.ok(JSON.stringify(t.toJSON()).includes('"Name":"AUTH_MODE","Value":"cognito"'));
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
});
