import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModules, describeModules } from '../lib/modules';
const ctx = (values: Record<string, unknown>) => (key: string) => values[key];
const domain = { domainName: 'd.example.com', hostedZoneId: 'Z1', hostedZoneName: 'example.com' };

test('defaults reproduce the current deployment: https, every module on, four base images', () => {
  const m = resolveModules(ctx(domain));
  assert.equal(m.ingress.mode, 'https');
  assert.deepEqual([m.gateway, m.sourceBuild, m.edge, m.waf, m.alarms], [true, true, true, true, true]);
  assert.deepEqual(m.images.build, ['mujoco', 'isaaclab', 'ros2', 'workspace']);
  assert.deepEqual(m.images.overrides, {});
  assert.deepEqual(m.resourceTag, { key: 'PhysicalAI', value: 'true' });
});
test('extendedImages adds groot and openpi; images= narrows the list; unknown names fail', () => {
  assert.deepEqual(resolveModules(ctx({ ...domain, extendedImages: 'true' })).images.build, ['mujoco', 'isaaclab', 'ros2', 'workspace', 'groot', 'openpi']);
  assert.deepEqual(resolveModules(ctx({ ...domain, images: 'mujoco, ros2' })).images.build, ['mujoco', 'ros2']);
  assert.throws(() => resolveModules(ctx({ ...domain, images: 'mujoco,nope' })), /Unknown workload image "nope"/);
});
test('imageOverrides must be ECR URIs pinned by digest or tag and remove the image from the build list', () => {
  const uri = '913524902871.dkr.ecr.us-east-1.amazonaws.com/pai/mujoco@sha256:' + 'a'.repeat(64);
  const m = resolveModules(ctx({ ...domain, imageOverrides: JSON.stringify({ mujoco: uri }) }));
  assert.equal(m.images.overrides.mujoco, uri);
  assert.deepEqual(m.images.build, ['isaaclab', 'ros2', 'workspace']);
  assert.throws(() => resolveModules(ctx({ ...domain, imageOverrides: '{"mujoco":"docker.io/library/python:3"}' })), /imageOverrides\.mujoco must be an ECR image URI/);
  assert.throws(() => resolveModules(ctx({ ...domain, imageOverrides: 'not json' })), /imageOverrides must be a JSON object/);
});
test('boolean toggles accept true/false strings only', () => {
  const m = resolveModules(ctx({ ...domain, gateway: 'false', waf: false, alarms: 'false', edge: 'false', sourceBuild: 'false' }));
  assert.deepEqual([m.gateway, m.sourceBuild, m.edge, m.waf, m.alarms], [false, false, false, false, false]);
  assert.throws(() => resolveModules(ctx({ ...domain, gateway: 'yes' })), /gateway must be true or false/);
});
test('domain keys are all-or-nothing; none means http ingress', () => {
  assert.equal(resolveModules(ctx({})).ingress.mode, 'http');
  assert.throws(() => resolveModules(ctx({ domainName: 'd.example.com' })), /domainName, hostedZoneId and hostedZoneName must be given together/);
});
test('resource tag key and value are overridable and validated', () => {
  assert.deepEqual(resolveModules(ctx({ ...domain, resourceTagKey: 'Team', resourceTagValue: 'robotics' })).resourceTag, { key: 'Team', value: 'robotics' });
  assert.throws(() => resolveModules(ctx({ ...domain, resourceTagKey: 'aws:reserved' })), /resourceTagKey/);
});
test('describeModules lists every decision on one line each', () => {
  const text = describeModules(resolveModules(ctx({ ...domain, gateway: 'false' })));
  assert.match(text, /ingress: https d\.example\.com/);
  assert.match(text, /gateway: off/);
  assert.match(text, /images: mujoco, isaaclab, ros2, workspace/);
});
