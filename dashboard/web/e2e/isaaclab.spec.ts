/**
 * Parent-run release-two gate. No AWS SDK/server imports or capacity mutations.
 * Discovery/typechecking do not authenticate or submit work. See README.isaaclab.md.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { test as researcherTest, expect, budgets, requireCondition, type Researcher } from './researcher-helpers/fixture';
import type { Recipe, Run, RunDetail, Task, Version } from './researcher-helpers/contracts';

const test = researcherTest.extend<{ isaacRelease: void }>({
  isaacRelease: [async ({}, use) => {
    requireCondition(process.env.DASHBOARD_ISAACLAB_LIVE === '1',
      'Isaac Lab requires DASHBOARD_ISAACLAB_LIVE=1 after parent release-two deployment; no automatic GPU execution');
    await use();
  }, { auto: true }],
});
test.use({ ignoreHTTPSErrors: false, screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
test.setTimeout(20 * 60_000);

const simulatorTask = 'Workshop-SO101-Reach-v0';
const platform = 'ml.g5.8xlarge';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const redacted = (text: string) => text
  .replace(/https?:\/\/\S+/gi, '[URL omitted]')
  .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/((?:token|password|signature|credential|ticket)\s*[=:]\s*)\S+/gi, '$1[redacted]')
  .slice(0, 1600);
const pinned = (version: string) => {
  requireCondition(typeof version === 'string' && version.length > 0 && version !== 'null', 'A committed object VersionId is required');
};
interface CatalogRecipe extends Recipe { templateVersion: number; contentHash: string }
interface GPUResource { cpu: number; memory: string; gpu: number; platform: string; shm_size: string }
interface RecipeDocument {
  workflow: {
    name: string; mlflow: boolean; resources: Record<string, GPUResource>;
    timeout: { queue_timeout: string; start_timeout: string; exec_timeout: string };
    tasks: {
      name: string; resource: string; image: string; command: string[]; args: string[];
      parallelism?: number; retry?: { max_retries: number }; timeout?: string;
      environment: Record<string, string>;
      inputs?: { dataset: { name: string; version: number } }[];
      outputs: { dataset: { name: string; path: string } }[];
    }[];
  };
  'default-values': Record<string, string>;
}
interface RecipeRun extends Run {
  templateId: string; templateVersion: number; templateContentHash: string; templateModified: boolean;
  specHash: string; spec: RecipeDocument;
}
interface GPUNode {
  name: string; instanceType: string; ready: boolean; unschedulable: boolean; gpuCapacity: number; gpuAllocatable: number;
}
interface GPUJob {
  name: string; namespace: string; workflowId: string; task: string; gpu: string; completions: number;
  nodeSelector: Record<string, string>; pods: { name: string; node?: string; phase: string }[];
}
interface PublishedVersion extends Version { producedAttempt: number; publicationId: string }
interface ObjectPin { path: string; key: string; bytes: number; versionId: string; checksumSHA256: string; checksumType: string }
interface Manifest { schemaVersion: number; identity: string; objects: ObjectPin[] }
interface CheckpointProof {
  path: string; sha256: string; bytes: number; iteration: number; modelStateSHA256: string;
  optimizerSteps: { min: number; max: number; parameters: number };
}
interface GPUProof {
  schemaVersion: number; mode: string; nonce: string; runId: string; taskName: string; attempt: number;
  gpu: { available: boolean; deviceCount: number; name: string; torchVersion: string; cudaVersion: string; kernelCheck: number };
  training: { task: string; seed: number; iterations: number; resume: string; checkpoint: string; evaluationType: string };
  first: CheckpointProof; second: CheckpointProof; final: CheckpointProof;
  configuration: { numEnvs: number; simulationDevice: string; policyDevice: string; seed: number; stepsPerEnvironment: number };
  losses: Record<string, { step: number; value: number }[]>;
  inputCheckpoint: CheckpointProof;
  video: { path: string; bytes: number; sha256: string };
}
type Remaining = (maximum: number) => number;

async function submit(researcher: Researcher, mode: 'train' | 'video', remaining: Remaining,
  evidence: Record<string, unknown>, input?: { dataset: string; version: number; checkpointSHA256: string }) {
  const recipe = await researcher.api<CatalogRecipe>('GET', `/api/templates/isaaclab-${mode}`, undefined, [200], remaining(budgets.api));
  expect(recipe.id).toBe(`isaaclab-${mode}`);
  expect(recipe.templateVersion).toBeGreaterThan(0);
  expect(recipe.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const document = YAML.parse(recipe.yaml) as RecipeDocument;
  expect(document.workflow.tasks).toHaveLength(1);
  const task = document.workflow.tasks[0];
  expect(task.name).toBe(mode);
  const source = `/opt/recipes/isaaclab/${mode === 'train' ? 'train' : 'play'}.py`;
  expect(task.command).toEqual(['/isaac-sim/python.sh', source]);
  expect(task.resource).toBe('gpu');
  const resource = document.workflow.resources[task.resource];
  expect(resource).toMatchObject({ cpu: 8, memory: '32Gi', gpu: 1, platform, shm_size: '8Gi' });
  expect(task.outputs).toHaveLength(1);
  expect(task.outputs[0].dataset.name).toContain('{{workflow_id}}');
  expect(task.outputs[0].dataset.path).toBe('{{output}}');
  const image = document['default-values'].image;
  requireCondition(typeof image === 'string' && image.length > 0 && !image.startsWith('required://'),
    'The deployed ISAACLAB_IMAGE_URI is missing; no substitute image or CPU fallback');
  expect(task.environment.ACCEPT_EULA).toBe('Y'); // Existing template's licensed-image contract.
  if (mode === 'train') {
    for (const option of ['--seed', '--num-envs', '--iterations', '--checkpoint-every', '--resume', '--headless'])
      expect(task.args).toContain(option);
  } else {
    for (const option of ['--video', '--video_length', '--video_dir', '--headless', '--enable_cameras'])
      expect(task.args).toContain(option);
    expect(task.args[task.args.indexOf('--num_envs') + 1]).toBe('1');
    expect(task.args).toContain('{{input:0}}/{{ checkpoint_file }}');
    requireCondition(input, 'Playback requires this test’s committed training dataset');
    task.inputs = [{ dataset: { name: input.dataset, version: input.version } }];
  }
  // This test exercises GPU PPO/video, not MLflow connectivity or quality approval.
  document.workflow.mlflow = false;
  document.workflow.name = `e2e-isaac-${mode}-${researcher.tag}`;
  document.workflow.resources = { gpu: resource };
  document.workflow.timeout = { queue_timeout: '3m', start_timeout: '5m', exec_timeout: mode === 'train' ? '8m' : '6m' };
  task.timeout = mode === 'train' ? '8m' : '6m';
  task.parallelism = 1;
  task.retry = { max_retries: 0 };
  const recipeArgs = task.args;
  // -c keeps the diagnostic launcher under e2e only; the image's recipe stays unchanged.
  task.command = ['/isaac-sim/python.sh', '-c',
    readFileSync(resolve(__dirname, 'researcher-helpers/isaaclab_probe.py'), 'utf8')];
  task.args = ['--mode', mode, '--nonce', researcher.tag,
    ...(input ? ['--checkpoint-sha256', input.checkpointSHA256] : []), '--', source, ...recipeArgs];
  const overrides = mode === 'train'
    ? { task: simulatorTask, num_envs: '32', iterations: '2', checkpoint_every: '1', seed: '42', resume: '' }
    : { task: simulatorTask, dataset_name: input!.dataset, checkpoint_file: 'model_final.pt', video_length: '96' };
  const yaml = YAML.stringify(document, { lineWidth: 0 });
  const preview = await researcher.api<{
    ok: boolean; error?: string; order: string[];
    tasks: { image: string; parallelism: number; resource: GPUResource }[];
  }>('POST', '/api/workflows/validate', { yaml, overrides }, [200], remaining(budgets.api));
  requireCondition(preview.ok, `Isaac Lab ${mode} preflight failed: ${redacted(preview.error ?? 'image/profile/runtime/dataset prerequisite missing')}`);
  expect(preview.order).toEqual([mode]);
  expect(preview.tasks).toHaveLength(1);
  expect(preview.tasks[0]).toMatchObject({ parallelism: 1, resource });
  expect(preview.tasks[0].image).toMatch(/@sha256:[a-f0-9]{64}$/);
  const record: Researcher['runs'][number] = {
    name: document.workflow.name, task: mode, idempotencyKey: `isaac-${mode}-${researcher.tag}`,
  };
  researcher.runs.push(record);
  const body = { yaml, overrides, templateId: recipe.id, templateVersion: recipe.templateVersion, acknowledgePreflight: true };
  const create = () => researcher.api<RecipeRun>('POST', '/api/workflows', body, [202], remaining(budgets.api),
    { 'idempotency-key': record.idempotencyKey });
  let run: RecipeRun;
  try { run = await create(); }
  catch {
    try { run = await create(); } // Same intent, never a fresh run on a lost reply.
    catch (error) {
      const matches = (await researcher.api<Run[]>('GET', `/api/workflows?q=${encodeURIComponent(record.name)}`,
        undefined, [200], remaining(budgets.api))).filter(item =>
        item.name === record.name && item.projectId === researcher.project.id && item.ownerSubject === researcher.principal.subject);
      if (matches.length === 1) Object.assign(record, { id: matches[0].id, status: matches[0].status });
      throw error;
    }
  }
  requireCondition(/^[a-z0-9][a-z0-9-]{0,62}$/.test(run.id), 'Submission returned an invalid workflow ID');
  record.id = run.id;
  record.status = run.status;
  expect(run).toMatchObject({ name: record.name, projectId: researcher.project.id, ownerSubject: researcher.principal.subject,
    templateId: recipe.id, templateVersion: recipe.templateVersion, templateContentHash: recipe.contentHash, templateModified: true });
  expect(run.spec.workflow.tasks[0].image).toBe(preview.tasks[0].image);
  const dataset = task.outputs[0].dataset.name.replaceAll('{{workflow_id}}', run.id);
  researcher.datasets.push({ name: dataset });
  evidence[`${mode}Submission`] = { runId: run.id, dataset, recipe: recipe.id, templateVersion: recipe.templateVersion,
    templateContentHash: recipe.contentHash, specHash: run.specHash, image: run.spec.workflow.tasks[0].image,
    yamlSHA256: sha256(yaml), overrides, resource };
  console.log(`[isaaclab] ${mode} run=${run.id} dataset=${dataset} gpu=1 platform=${platform}`);
  return { run, dataset };
}

async function complete(researcher: Researcher, run: Run, mode: string, node: string,
  remaining: Remaining, evidence: Record<string, unknown>): Promise<RunDetail> {
  let placement: GPUJob | undefined;
  let lastState = '';
  const detail = await researcher.poll(`Isaac Lab ${mode}`, remaining(mode === 'train' ? 11 * 60_000 : 7 * 60_000),
    async timeout => {
      const observed = await researcher.detail(run.id, timeout);
      const state = `${observed.workflow.status}; ${observed.tasks.map(task => `${task.name}:${task.phase}`).join(',')}`;
      if (state !== lastState) {
        console.log(`[isaaclab] run=${run.id} ${state}`);
        lastState = state;
      }
      if (!placement) {
        const jobs = await researcher.api<GPUJob[]>('GET',
          `/api/k8s/jobs?ns=${encodeURIComponent(researcher.project.namespace)}`, undefined, [200], remaining(budgets.api));
        const job = jobs.find(item => item.workflowId === run.id && item.task === mode && item.namespace === researcher.project.namespace);
        if (job?.pods.some(pod => pod.node)) {
          expect(job.completions).toBe(1);
          expect(Number(job.gpu)).toBe(1);
          expect(job.nodeSelector['node.kubernetes.io/instance-type']).toBe(platform);
          expect(job.pods).toHaveLength(1);
          expect(job.pods[0].node, 'Use the already existing single-GPU node').toBe(node);
          placement = job;
          evidence[`${mode}Placement`] = { job: job.name, node: job.pods[0].node, pod: job.pods[0].name, gpu: Number(job.gpu) };
        }
      }
      return observed;
    }, observed => {
      requireCondition(!['FAILED', 'CANCELLED'].includes(observed.workflow.status),
        `Isaac Lab ${mode} ${run.id} ended ${observed.workflow.status}: ${redacted(observed.tasks.map(task => task.message ?? task.phase).join('; '))}`);
      return observed.workflow.status === 'SUCCEEDED' && observed.tasks.length === 1 && observed.tasks[0].phase === 'SUCCEEDED';
    }, observed => `${observed.workflow.status}; ${observed.tasks.map(task => `${task.name}:${task.phase}`).join(',')}`);
  requireCondition(placement, 'No actual backend node placement was observed; completed status alone is insufficient');
  return detail;
}

async function publication(researcher: Researcher, runId: string, task: Task, dataset: string, remaining: Remaining) {
  expect(task).toMatchObject({ phase: 'SUCCEEDED', attempts: 1, exitCode: 0, wrapperExitCode: 0 });
  expect(task.runtimeFailure ?? false).toBe(false);
  expect(task.outputPath).toBe(`/fsx/checkpoints/projects/${researcher.project.id}/runs/${runId}/attempts/1/${task.name}`);
  expect(task.publishedVersions).toHaveLength(1);
  const produced = task.publishedVersions![0];
  expect(produced.dataset).toBe(dataset);
  const detail = await researcher.poll(`Isaac Lab ${task.name} READY artifact`, remaining(90_000),
    timeout => researcher.dataset(dataset, timeout),
    value => value.versions.some(version => version.version === produced.version && version.state === 'READY'),
    value => value.versions.find(version => version.version === produced.version)?.state ?? 'missing');
  const version = detail.versions.find(value => value.version === produced.version)! as PublishedVersion;
  expect(version.producedBy).toEqual({ workflowId: runId, task: task.name });
  expect(version.producedAttempt).toBe(1);
  expect(version.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(version.publicationId).toBeTruthy();
  expect(Number.isFinite(Date.parse(version.verifiedAt!))).toBe(true);
  expect(Object.values(task.artifactReceipts ?? {})).toEqual(expect.arrayContaining([
    expect.objectContaining({ uri: version.uri, manifestUri: version.manifestUri, manifestHash: version.manifestHash }),
  ]));
  const bytes = await researcher.versionFile(version, 'manifest.json');
  expect(sha256(bytes)).toBe(version.manifestHash);
  const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.identity).toBe(`workflow:${version.publicationId}:1`);
  expect(manifest.objects.length).toBe(version.objectCount);
  expect(manifest.objects.reduce((sum, object) => sum + object.bytes, 0)).toBe(version.sizeBytes);
  expect(new Set(manifest.objects.map(object => object.path)).size).toBe(manifest.objects.length);
  requireCondition(manifest.objects.length > 0 && manifest.objects.length <= 128, 'Unexpected empty/oversized minimal-run inventory');
  for (const object of manifest.objects) {
    requireCondition(!object.path.startsWith('/') && !object.path.includes('..') && !object.path.includes('\\'),
      'Unsafe relative path in READY artifact inventory');
    pinned(object.versionId);
    expect(`s3://${new URL(version.uri).hostname}/${object.key}`).toBe(version.uri + object.path);
  }
  Object.assign(researcher.datasets.find(item => item.name === dataset)!, {
    version: version.version, state: version.state, manifestHash: version.manifestHash,
  });
  return { version, manifest };
}

async function objectBytes(researcher: Researcher, publication: { version: Version; manifest: Manifest }, path: string) {
  const matches = publication.manifest.objects.filter(object => object.path === path);
  expect(matches, `Committed object ${path}`).toHaveLength(1);
  const pin = matches[0];
  expect(pin.checksumType).toBe('FULL_OBJECT');
  requireCondition(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= 128 * 1024 * 1024,
    'Minimal proof transfer must be nonempty and at most 128 MiB');
  const bytes = await researcher.versionFile(publication.version, path);
  // Generic dataset presign uses the current URL; a mutation must fail this check.
  // Never accept current bytes that differ from the committed version's SHA256.
  expect(bytes.length).toBe(pin.bytes);
  expect(createHash('sha256').update(bytes).digest('base64')).toBe(pin.checksumSHA256);
  return bytes;
}

function checkGPU(proof: GPUProof, researcher: Researcher, run: Run, mode: string) {
  expect(proof).toMatchObject({ schemaVersion: 1, mode, nonce: researcher.tag, runId: run.id, taskName: mode, attempt: 1 });
  expect(proof.gpu).toMatchObject({ available: true, deviceCount: 1, kernelCheck: 1240 });
  requireCondition(proof.gpu.name && proof.gpu.cudaVersion && proof.gpu.torchVersion, 'Actual CUDA/device metadata is missing');
}

test('one existing GPU trains Isaac Lab PPO, publishes learned checkpoints, then renders the pinned policy to a READY video', async ({ researcher }, info) => {
  const evidence: Record<string, unknown> = { projectId: researcher.project.id, tag: researcher.tag, outcome: 'incomplete' };
  const deadline = Date.now() + 18 * 60_000;
  const remaining: Remaining = maximum => {
    requireCondition(Date.now() < deadline, 'Isaac Lab exhausted its 18-minute work budget; own-run cleanup follows');
    return Math.max(1, Math.min(maximum, deadline - Date.now()));
  };
  try {
    const nodes = await researcher.api<GPUNode[]>('GET', '/api/k8s/nodes', undefined, [200], remaining(budgets.api));
    const baseline = nodes.filter(node => node.instanceType === platform);
    requireCondition(baseline.length === 1 && baseline[0].ready && !baseline[0].unschedulable
      && baseline[0].gpuCapacity === 1 && baseline[0].gpuAllocatable === 1,
    'Expected the existing ready ml.g5.8xlarge with one allocatable GPU; this test never scales or provisions nodes');
    evidence.gpuBaseline = { node: baseline[0].name, platform, gpu: 1 };
    const train = await submit(researcher, 'train', remaining, evidence);
    const trained = await complete(researcher, train.run, 'train', baseline[0].name, remaining, evidence);
    const training = await publication(researcher, train.run.id, trained.tasks[0], train.dataset, remaining);
    const proof = JSON.parse((await objectBytes(researcher, training, 'isaaclab-proof.json')).toString('utf8')) as GPUProof;
    checkGPU(proof, researcher, train.run, 'train');
    expect(proof.training).toEqual({ task: simulatorTask, seed: 42, iterations: 2, resume: '',
      checkpoint: 'model_final.pt', evaluationType: 'training_only' });
    expect(proof.configuration).toMatchObject({ numEnvs: 32, seed: 42 });
    expect(proof.configuration.simulationDevice).toMatch(/^cuda/);
    expect(proof.configuration.policyDevice).toMatch(/^cuda/);
    expect(proof.configuration.stepsPerEnvironment).toBeGreaterThan(0);
    expect(proof.first.iteration).toBe(0);
    expect(proof.second.iteration).toBe(1);
    expect(proof.final.iteration).toBe(1);
    expect(proof.final.modelStateSHA256).not.toBe(proof.first.modelStateSHA256);
    expect(proof.second.modelStateSHA256).toBe(proof.final.modelStateSHA256);
    expect(proof.first.optimizerSteps.min).toBeGreaterThan(0);
    expect(proof.final.optimizerSteps.min).toBeGreaterThan(proof.first.optimizerSteps.max);
    expect(Object.keys(proof.losses).length).toBeGreaterThanOrEqual(2);
    for (const values of Object.values(proof.losses)) {
      expect([...new Set(values.map(value => value.step))].sort()).toEqual([0, 1]);
      expect(values.every(value => Number.isFinite(value.value))).toBe(true);
    }
    for (const [path, pin] of [
      ['checkpoints/model_0.pt', proof.first], ['checkpoints/model_1.pt', proof.second], ['model_final.pt', proof.final],
    ] as const) {
      const bytes = await objectBytes(researcher, training, path);
      expect(bytes.length).toBe(pin.bytes);
      expect(sha256(bytes)).toBe(pin.sha256);
      expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK'); // Tensor archive; launcher also checked actual tensors.
    }
    const actualMetadata = JSON.parse((await objectBytes(researcher, training, 'training.json')).toString('utf8'));
    expect(actualMetadata).toEqual(proof.training);
    for (const path of ['environment.yaml', 'agent.yaml']) await objectBytes(researcher, training, path);
    evidence.training = { version: training.version, proof };
    // First workflow has fully finalized and released its GPU before playback is submitted.
    const play = await submit(researcher, 'video', remaining, evidence,
      { dataset: train.dataset, version: training.version.version, checkpointSHA256: proof.final.sha256 });
    expect(play.run.spec.workflow.tasks[0].image).toBe(train.run.spec.workflow.tasks[0].image);
    expect(play.run.datasetSnapshots?.video?.['0']).toMatchObject({
      name: train.dataset, version: training.version.version, manifestHash: training.version.manifestHash, uri: training.version.uri,
    });
    const played = await complete(researcher, play.run, 'video', baseline[0].name, remaining, evidence);
    const publicationResult = await publication(researcher, play.run.id, played.tasks[0], play.dataset, remaining);
    const playback = JSON.parse((await objectBytes(researcher, publicationResult, 'isaaclab-proof.json')).toString('utf8')) as GPUProof;
    checkGPU(playback, researcher, play.run, 'video');
    expect(playback.inputCheckpoint).toEqual(proof.final);
    expect(playback.video.path).toMatch(/^videos\/Workshop-SO101-Reach-v0_model_final.*\.mp4$/);
    expect(publicationResult.manifest.objects.filter(object => object.path.endsWith('.mp4'))).toHaveLength(1);
    const video = await objectBytes(researcher, publicationResult, playback.video.path);
    expect(video.length).toBe(playback.video.bytes);
    expect(sha256(video)).toBe(playback.video.sha256);
    expect(video.subarray(4, 8).toString('ascii')).toBe('ftyp');
    // Decode the verified bytes using a local Blob: no signed URL leaks or storage CORS assumptions.
    await researcher.page.evaluate(base64 => {
      const element = document.createElement('video');
      element.id = 'isaaclab-e2e-video';
      element.setAttribute('aria-label', 'Isaac Lab policy playback');
      element.controls = true;
      element.muted = true;
      element.preload = 'auto';
      element.src = URL.createObjectURL(new Blob(
        [Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'video/mp4' }));
      document.body.append(element);
      element.load();
    }, video.toString('base64'));
    const player = researcher.page.locator('#isaaclab-e2e-video');
    try {
      await expect.poll(() => player.evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth, height: element.videoHeight, playable: element.readyState >= 2 && element.duration > 0,
      })), { timeout: remaining(30_000) }).toEqual({ width: 1280, height: 720, playable: true });
      // Offscreen rendering may have a black startup frame; inspect the middle of the actual video.
      await player.evaluate((element: HTMLVideoElement) => { element.currentTime = element.duration / 2; });
      await expect.poll(() => player.evaluate((element: HTMLVideoElement) =>
        !element.seeking && element.currentTime > 0 && element.readyState >= 2),
      { timeout: remaining(10_000) }).toBe(true);
      const metadata = await player.evaluate((element: HTMLVideoElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 36;
        const context = canvas.getContext('2d')!;
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = new Set(Array.from({ length: pixels.length / 4 }, (_, index) =>
          `${pixels[index * 4]},${pixels[index * 4 + 1]},${pixels[index * 4 + 2]}`));
        return { durationSeconds: element.duration, width: element.videoWidth, height: element.videoHeight, distinctColors: colors.size };
      });
      expect(metadata.durationSeconds).toBeGreaterThan(1);
      expect(metadata.durationSeconds).toBeLessThan(30);
      expect(metadata.distinctColors, 'A decoded simulator frame must not be a blank image').toBeGreaterThan(16);
      evidence.playback = { version: publicationResult.version, proof: playback, decode: metadata };
    } finally {
      await player.evaluate((element: HTMLVideoElement) => { URL.revokeObjectURL(element.src); element.remove(); });
    }
    const finalNodes = (await researcher.api<GPUNode[]>('GET', '/api/k8s/nodes', undefined, [200], remaining(budgets.api)))
      .filter(node => node.instanceType === platform);
    expect(finalNodes.map(node => ({ name: node.name, gpuCapacity: node.gpuCapacity })))
      .toEqual([{ name: baseline[0].name, gpuCapacity: 1 }]);
    evidence.outcome = 'verified';
  } finally {
    if (evidence.outcome !== 'verified') {
      const diagnostics = [];
      for (const record of researcher.runs.filter(record => record.id)) {
        try {
          const logs = await researcher.api<{ source: string; lines: string[] }>('GET',
            `/api/workflows/${record.id}/tasks/${record.task}/logs?tail=120`, undefined, [200], 10_000);
          diagnostics.push({ runId: record.id, task: record.task, source: logs.source,
            lines: logs.lines.slice(-80).map(redacted) });
        } catch { diagnostics.push({ runId: record.id, task: record.task, error: 'Bounded task diagnostic fetch unavailable' }); }
      }
      evidence.failureDiagnostics = diagnostics;
    }
    const proofPath = info.outputPath('isaaclab-proof.json');
    mkdirSync(dirname(proofPath), { recursive: true });
    writeFileSync(proofPath, JSON.stringify(evidence, null, 2));
    await info.attach('isaaclab-proof', { contentType: 'application/json', path: proofPath });
    // Researcher fixture always cancels only the recorded unfinished runs, with a separate 3-minute cleanup deadline.
  }
});
