import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WorkloadImages } from '../lib/constructs/workload-images';
const root = path.resolve(__dirname, '../../..');
function build(props: ConstructorParameters<typeof WorkloadImages>[2]) {
  const app = new cdk.App({ context: { 'aws:cdk:asset-staging': false } });
  const stack = new cdk.Stack(app, 'T', { env: { account: '913524902871', region: 'us-east-1' } });
  const images = new WorkloadImages(stack, 'WorkloadImages', props);
  return { images, template: Template.fromStack(stack) };
}
test('builds only the listed images and names env by IMAGE_ENV', () => {
  const { images, template } = build({ repositoryRoot: root, build: ['mujoco', 'workspace'], overrides: {} });
  assert.deepEqual(Object.keys(images.environment).sort(), ['MUJOCO_IMAGE_URI', 'WORKSPACE_IMAGE_URI']);
  const outputs = Object.keys(template.toJSON().Outputs ?? {});
  assert.ok(outputs.some(o => o.startsWith('WorkloadImagesmujocoImage')));
  assert.ok(!outputs.some(o => o.startsWith('WorkloadImagesisaaclabImage')));
});
test('overrides become env values verbatim without an asset', () => {
  const uri = '913524902871.dkr.ecr.us-east-1.amazonaws.com/pai/ros2@sha256:' + 'b'.repeat(64);
  const { images } = build({ repositoryRoot: root, build: ['mujoco'], overrides: { ros2: uri } });
  assert.equal(images.environment.ROS2_IMAGE_URI, uri);
  assert.ok(images.environment.MUJOCO_IMAGE_URI && !images.environment.MUJOCO_IMAGE_URI.includes('@sha256'));
});
