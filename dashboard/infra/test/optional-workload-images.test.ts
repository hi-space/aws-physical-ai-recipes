import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { WorkloadImages, workloadContext } from '../lib/constructs/workload-images';

const digest = `sha256:${'a'.repeat(64)}`;
const recipe = `123456789012.dkr.ecr.us-east-1.amazonaws.com/isaac@${digest}`;
const assetsImage = `123456789012.dkr.ecr.us-east-1.amazonaws.com/assets@${digest}`;
const cosmos = { baseImage: `nvcr.io/nvidia/cosmos/cosmos-predict2-container@${digest}`, uvImage: `ghcr.io/astral-sh/uv@${digest}` };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-optional-test-'));
  for (const dir of ['dashboard/images', 'dashboard/recipes', 'dashboard/session-image',
    'hyperpod-training/mujoco-workshop', 'hyperpod-training/isaac-lab-workshop',
    'hyperpod-training/examples/rl', 'hyperpod-training/configs', 'e2e-workshop/groot/training/data']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of ['hyperpod-training/examples/rl/play_isaaclab.py', 'hyperpod-training/configs/so101_modality.py',
    'e2e-workshop/groot/training/data/convert_v3_to_v2.py', 'dashboard/session-image/Dockerfile',
    'dashboard/recipes/script.py']) fs.writeFileSync(path.join(root, file), 'fixture', { mode: 0o600 });
  for (const name of ['mujoco', 'isaaclab', 'ros2', 'groot', 'openpi', 'cosmos', 'leisaac']) {
    fs.mkdirSync(path.join(root, 'dashboard/images', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'dashboard/images', name, 'Dockerfile'), 'FROM scratch\n');
  }
  fs.mkdirSync(path.join(root, 'dashboard/recipes/.venv'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard/recipes/.venv/ignored'), 'private');
  return root;
}
function synth(root: string, optionalImages?: unknown) {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'pai-optional-out-')) });
  const stack = new cdk.Stack(app, 'Test', { env: { account: '123456789012', region: 'us-east-1' } });
  const images = new WorkloadImages(stack, 'Images', { repositoryRoot: root, optionalImages } as ConstructorParameters<typeof WorkloadImages>[2]);
  const assembly = app.synth();
  const manifest = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'Test.assets.json'), 'utf8'));
  return { environment: images.environment, assets: manifest.dockerImages as Record<string, { displayName: string; source: { dockerBuildArgs?: Record<string, string> } }> };
}
test('optional Cosmos and LeIsaac require explicit pinned inputs without changing default asset hashes', () => {
  const root = fixture();
  const baseline = synth(root);
  assert.equal(baseline.environment.COSMOS_IMAGE_URI, undefined);
  assert.equal(baseline.environment.LEISAAC_IMAGE_URI, undefined);
  const enabled = synth(root, { cosmos, leisaac: { isaaclabRecipeImage: recipe, assetsImage, sceneRevision: digest } });
  assert.ok(enabled.environment.COSMOS_IMAGE_URI);
  assert.ok(enabled.environment.LEISAAC_IMAGE_URI);
  for (const hash of Object.keys(baseline.assets)) assert.ok(enabled.assets[hash], `Default asset changed: ${hash}`);
  const added = Object.entries(enabled.assets).filter(([hash]) => !baseline.assets[hash]).map(([, value]) => value.source.dockerBuildArgs);
  assert.ok(added.some(args => args?.COSMOS_BASE_IMAGE === cosmos.baseImage && args.UV_IMAGE === cosmos.uvImage));
  assert.ok(added.some(args => args?.ISAACLAB_RECIPE_IMAGE === recipe && args.LEISAAC_ASSETS_IMAGE === assetsImage && args.LEISAAC_SCENE_REVISION === digest));
});
test('missing or mutable build args and mismatched scene identity fail before optional assets can be emitted', () => {
  const root = fixture();
  assert.throws(() => synth(root, { cosmos: { baseImage: cosmos.baseImage } }), /UV_IMAGE|uvImage/);
  assert.throws(() => synth(root, { cosmos: { ...cosmos, baseImage: 'nvcr.io/nvidia/cosmos/image:latest' } }), /digest/);
  assert.throws(() => synth(root, { leisaac: { isaaclabRecipeImage: recipe, assetsImage, sceneRevision: `sha256:${'b'.repeat(64)}` } }), /scene|SCENE/);
});
test('0390e2b staging permissions and dependency-directory exclusions remain intact', () => {
  const context = workloadContext(fixture());
  assert.equal(fs.statSync(path.join(context, 'dashboard/recipes/script.py')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(context, 'dashboard/recipes')).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(context, 'dashboard/recipes/.venv')), false);
});
