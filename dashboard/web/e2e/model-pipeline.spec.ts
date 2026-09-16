/**
 * Parent-run live test. From dashboard/web, with the existing parent-injected
 * DASHBOARD_URL, DASHBOARD_USER, DASHBOARD_PASSWORD and DASHBOARD_PROJECT_ID:
 *
 * DASHBOARD_RESEARCHER_LIVE=1 npx playwright test e2e/model-pipeline.spec.ts \
 *   --workers=1 --retries=0 --timeout=900000
 *
 * Budget: 15 minutes, including up to 12 minutes for CPU scheduling/execution.
 * The shared fixture has separate login and 3-minute failure-cleanup budgets.
 * Optional DASHBOARD_MODEL_PIPELINE_EPISODES=2 requires REVIEW, never approval.
 * Safe local discovery: npx playwright test e2e/model-pipeline.spec.ts --list
 *
 * No AWS clients, server imports, mock learning, or hardware operations. Only
 * the deployed dashboard and its authenticated, presigned artifact transfers.
 * Completed datasets/models/evaluations remain as evidence; fixture teardown
 * cancels only this test's owned unfinished workflow. It never approves models.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { test, expect, budgets, requireCondition, type Researcher } from './researcher-helpers/fixture';
import type { Recipe, Run, RunDetail, Task, Version } from './researcher-helpers/contracts';

test.use({ ignoreHTTPSErrors: false, screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
test.setTimeout(15 * 60_000);

// Wire types only: importing dashboard server modules can initialize AWS clients.
interface Pipeline {
  workflow: {
    name: string;
    mlflow: boolean;
    resources: Record<string, { cpu: number; memory: string; gpu: number; platform: string }>;
    tasks: {
      name: string; resource: string; image: string; command: string[]; args: string[];
      inputs?: { task: string }[];
      outputs: { dataset: { name: string; path: string } }[];
    }[];
  };
  ui?: { recipe?: { sources?: string[] } };
}
interface PinnedRecipe extends Recipe { templateVersion: number; contentHash: string }
interface PipelineRun extends Run {
  templateId: string; templateVersion: number; templateContentHash: string; templateModified: boolean;
  specHash: string; spec: Pipeline;
  imagePins?: Record<string, { image: string; profileId: string; profileVersion: number }>;
}
interface PublishedVersion extends Version { producedAttempt: number; publicationId: string }
interface ObjectPin {
  path: string; key: string; bucket: string; versionId: string;
  checksumSHA256: string; checksumType: string; bytes: number; sha256?: string;
  fullSHA256?: string;
}
interface Manifest {
  schemaVersion: number; identity: string;
  objects: Omit<ObjectPin, 'bucket' | 'sha256'>[];
}
interface Source {
  workflowId: string; task: string; attempt: number; image: string; workflowSpecHash: string;
  dataset: { name: string; version: number; uri: string; manifestUri: string; manifestHash: string; manifestVersionId: string };
  inputs: unknown[]; upstreamTasks: string[];
}
interface Gate {
  id: string; evaluationId: string; approved: boolean;
  policy: { minimumEpisodes: number; minimumSuccessRate: number; maximumLatencyP95Ms: number };
  decision: { status: 'pass' | 'fail' | 'review'; reasons: string[] };
}
interface Model {
  id: string; name: string; projectId: string; ownerSubject: string;
  source: Source; checkpoint: ObjectPin; normalization?: ObjectPin;
  bundle?: { path: string; manifest: ObjectPin; task: string; seed: number; simulator: Record<string, string> };
  qualityApproval?: Gate; lastGate?: Gate;
}
interface Evaluation {
  id: string; modelId: string; projectId: string; ownerSubject: string;
  verification: string; inputMatch: string; source: Source; report: ObjectPin; primaryVideo: ObjectPin;
  metrics: { kind: string; episodes: number; successes: number; latencyP95Ms: number };
  task: string; seed: number; checkpointDigest: string; normalizationDigest: string;
  successRate: number; timeoutCount: number; latencyMs: Report['latencyMs']; simulator: Record<string, string>;
}
interface Report {
  schemaVersion: number; type: string; task: string; seed: number;
  episodeCount: number; successCount: number; successRate: number; timeoutCount: number;
  timeoutSeconds: number; checkpointDigest: string; normalizationDigest: string;
  latencyMs: { p50: number; p95: number; p99: number }; simulator: Record<string, string>; videoUri: string;
  episodes: {
    index: number; seed: number; steps: number; return: number; finalDistance: number;
    success: boolean; timeout: boolean; videoUri: string;
  }[];
}
interface Bundle {
  schemaVersion: number; algorithm: string; task: string; seed: number; timesteps: number;
  updates: number; normalization_count: number; sha256: Record<string, string>;
  simulator: Record<string, string>; sourceSha256: Record<string, string>; packages: Record<string, string>;
  initialTimesteps?: number; interrupted?: boolean;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const nonnegative = (value: number) => expect(Number.isFinite(value) && value >= 0).toBe(true);
const versioned = (value: string) => {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
  expect(value).not.toBe('null');
};

function checkBytes(bytes: Buffer, pin: Pick<ObjectPin, 'bytes' | 'checksumSHA256' | 'checksumType' | 'sha256'>) {
  expect(pin.checksumType).toBe('FULL_OBJECT');
  expect(bytes.length).toBe(pin.bytes);
  expect(createHash('sha256').update(bytes).digest('base64')).toBe(pin.checksumSHA256);
  if (pin.sha256 !== undefined) expect(sha256(bytes)).toBe(pin.sha256);
}

function manifestObject(manifest: Manifest, path: string) {
  const matches = manifest.objects.filter(object => object.path === path);
  expect(matches, `One published object for ${path}`).toHaveLength(1);
  const object = matches[0];
  versioned(object.versionId);
  expect(object.checksumType).toBe('FULL_OBJECT');
  expect(Buffer.from(object.checksumSHA256, 'base64')).toHaveLength(32);
  expect(object.bytes).toBeGreaterThan(0);
  return object;
}

function checkPin(pin: ObjectPin, manifest: Manifest, version: Version) {
  const object = manifestObject(manifest, pin.path);
  const { path, key, bytes, versionId, checksumSHA256, checksumType } = object;
  expect(pin).toMatchObject({ path, key, bytes, versionId, checksumSHA256, checksumType });
  expect(`s3://${pin.bucket}/${pin.key}`).toBe(version.uri + pin.path);
  expect(pin.sha256).toBe(Buffer.from(object.checksumSHA256, 'base64').toString('hex'));
  if (object.fullSHA256) expect(pin.sha256).toBe(object.fullSHA256);
}

async function readManifest(researcher: Researcher, version: PublishedVersion): Promise<Manifest> {
  // Generic presign does not accept VersionId. Bind these bytes to the committed
  // manifestHash; report/video downloads below use the version-pinned endpoint.
  expect(version.manifestUri).toBe(version.uri + 'manifest.json');
  const bytes = await researcher.versionFile(version, 'manifest.json');
  expect(sha256(bytes)).toBe(version.manifestHash);
  const manifest: Manifest = JSON.parse(bytes.toString('utf8'));
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.identity).toBe(`workflow:${version.publicationId}:${version.producedAttempt}`);
  expect(manifest.objects.length).toBe(version.objectCount);
  expect(manifest.objects.reduce((sum, object) => sum + object.bytes, 0)).toBe(version.sizeBytes);
  expect(new Set(manifest.objects.map(object => object.path)).size).toBe(manifest.objects.length);
  for (const object of manifest.objects) {
    requireCondition(!object.path.startsWith('/') && !object.path.includes('..') && !object.path.includes('\\'),
      'Published manifest contains an unsafe relative path');
    expect(`s3://${new URL(version.uri).hostname}/${object.key}`).toBe(version.uri + object.path);
    versioned(object.versionId);
  }
  return manifest;
}

async function readPublishedJson<T>(researcher: Researcher, version: Version, manifest: Manifest, path: string): Promise<T> {
  const pin = manifestObject(manifest, path);
  const bytes = await researcher.versionFile(version, path);
  // Fail if the current object changed; never substitute unverified current data
  // for the bytes described by this READY snapshot's full-object checksum.
  checkBytes(bytes, pin);
  return JSON.parse(bytes.toString('utf8')) as T;
}

async function readEvaluationArtifact(researcher: Researcher, evaluationId: string, kind: 'report' | 'video', pin: ObjectPin) {
  const path = `/api/evaluations/${encodeURIComponent(evaluationId)}/artifact?kind=${kind}`;
  const response = await researcher.page.request.get(researcher.origin + path, {
    headers: { origin: researcher.origin, 'x-pai-project': researcher.project.id },
    maxRedirects: 0, timeout: budgets.api,
  }).catch(() => { throw new Error(`Pinned ${kind} redirect failed; transport details omitted`); });
  let location: string;
  try {
    expect(response.status(), `Pinned ${kind} redirect`).toBe(302);
    expect(response.headers()['cache-control']).toContain('no-store');
    location = response.headers().location;
    requireCondition(location, `Pinned ${kind} redirect has no location`);
    // Never put a signed URL in assertions, attachments, or transport errors.
    let url: URL;
    try { url = new URL(location); } catch { throw new Error(`Pinned ${kind} URL is invalid`); }
    requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.hash,
      `Pinned ${kind} must use HTTPS`);
    requireCondition(url.searchParams.get('versionId') === pin.versionId,
      `Pinned ${kind} download did not select the registered VersionId`);
  } finally { await response.dispose(); }
  const bytes = await researcher.signedTransfer('GET', location);
  checkBytes(bytes, pin);
  return bytes;
}

function checkSource(source: Source, version: PublishedVersion, task: Task, run: PipelineRun) {
  expect(source).toMatchObject({
    workflowId: run.id, task: task.name, attempt: task.attempts, workflowSpecHash: run.specHash,
    image: run.spec.workflow.tasks.find(t => t.name === task.name)!.image,
    dataset: {
      name: version.dataset, version: version.version, uri: version.uri,
      manifestUri: version.manifestUri, manifestHash: version.manifestHash,
    },
  });
  versioned(source.dataset.manifestVersionId);
}

async function publication(researcher: Researcher, runId: string, task: Task, expectedName: string, budget: number) {
  expect(task.phase).toBe('SUCCEEDED');
  expect(task.exitCode).toBe(0);
  expect(task.wrapperExitCode).toBe(0);
  expect(task.runtimeFailure ?? false).toBe(false);
  expect(task.outputPath).toBe(`/fsx/checkpoints/projects/${researcher.project.id}/runs/${runId}/attempts/${task.attempts}/${task.name}`);
  expect(task.publishedVersions).toEqual([{ dataset: expectedName, version: 1 }]);
  researcher.datasets.push({ name: expectedName });
  const result = await researcher.poll(`model pipeline ${task.name} READY`, budget,
    remaining => researcher.dataset(expectedName, remaining),
    detail => detail.versions.some(version => version.version === 1 && version.state === 'READY'),
    detail => detail.versions.find(version => version.version === 1)?.state ?? 'missing');
  const version = result.versions.find(v => v.version === 1)! as PublishedVersion;
  expect(version.producedBy).toEqual({ workflowId: runId, task: task.name });
  expect(version.producedAttempt).toBe(task.attempts);
  expect(version.publicationId).toBeTruthy();
  expect(version.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isFinite(Date.parse(version.verifiedAt!))).toBe(true);
  expect(version.objectCount).toBeGreaterThan(0);
  expect(version.sizeBytes).toBeGreaterThan(0);
  expect(Object.values(task.artifactReceipts ?? {})).toEqual(expect.arrayContaining([
    expect.objectContaining({ uri: version.uri, manifestUri: version.manifestUri, manifestHash: version.manifestHash }),
  ]));
  Object.assign(researcher.datasets.find(d => d.name === expectedName)!, {
    version: 1, state: version.state, manifestHash: version.manifestHash,
  });
  return version;
}

test('real CPU MuJoCo output → registered model → verified evaluation and default quality gate', async ({ researcher }, info) => {
  const proofs: Record<string, unknown> = { projectId: researcher.project.id, tag: researcher.tag, liveOutcome: 'incomplete' };
  const deadline = Date.now() + 14 * 60_000;
  const remaining = (maximum: number) => {
    requireCondition(Date.now() < deadline, 'Model pipeline exhausted its 14-minute work budget; fixture will clean up its unfinished run');
    return Math.max(1, Math.min(maximum, deadline - Date.now()));
  };
  try {
    const episodes = process.env.DASHBOARD_MODEL_PIPELINE_EPISODES ?? '20';
    requireCondition(episodes === '20' || episodes === '2', 'DASHBOARD_MODEL_PIPELINE_EPISODES must be 20 or 2 (explicit review)');
    const recipe = await researcher.api<PinnedRecipe>('GET', '/api/templates/mujoco-pipeline');
    expect(recipe.id).toBe('mujoco-pipeline');
    expect(Number.isInteger(recipe.templateVersion) && recipe.templateVersion > 0).toBe(true);
    expect(recipe.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const pipeline = YAML.parse(recipe.yaml) as Pipeline;
    expect(pipeline.workflow.tasks.map(t => t.name)).toEqual(['train', 'evaluate']);
    const [trainSpec, evaluateSpec] = pipeline.workflow.tasks;
    expect(trainSpec.command).toEqual(['python', '/opt/recipes/mujoco/train.py']);
    expect(evaluateSpec.command).toEqual(['python', '/opt/recipes/mujoco/evaluate.py']);
    expect(evaluateSpec.inputs).toEqual([{ task: 'train' }]);
    expect(evaluateSpec.args).toContain('{{input:0}}/final');
    expect(pipeline.workflow.mlflow).toBe(false);
    for (const task of pipeline.workflow.tasks) {
      expect(task.resource).toBe('cpu');
      expect(task.outputs).toHaveLength(1);
      expect(task.outputs[0].dataset.name).toContain('{{workflow_id}}');
      expect(task.outputs[0].dataset.path).toBe('{{output}}');
    }
    pipeline.workflow.name = `e2e-model-${researcher.tag}`;
    pipeline.workflow.resources = { cpu: pipeline.workflow.resources.cpu };
    expect(pipeline.workflow.resources.cpu.gpu).toBe(0);
    // Smaller frames reduce software-rendering time and transfer size, retaining
    // the exact physics, trained policy, independent seeds and success criterion.
    evaluateSpec.args.push('--width', '160', '--height', '128');
    const overrides = { total_steps: '512', num_envs: '1', checkpoint_every: '256', episodes, seed: '42', eval_seed: '2042', resume: '' };
    const yaml = YAML.stringify(pipeline);
    proofs.recipe = {
      id: recipe.id, version: recipe.templateVersion, contentHash: recipe.contentHash,
      submittedYamlSha256: sha256(yaml), overrides, videoDimensions: [160, 128],
      sourceReferences: pipeline.ui?.recipe?.sources,
    };
    const preview = await researcher.api<{
      ok: boolean; order: string[]; vars: Record<string, string>;
      preflight: {
        projectId: string; status: 'blocked' | 'needs-review'; checkedAt: string;
        resolvedImageDigests: Record<string, string>;
        tasks: { task: string; profileId: string; profileVersion: number;
          image: { requestedImage: string; resolvedImage: string; digest: string };
          findings: { code: string; severity: string; message: string }[] }[];
      };
      tasks: { name: string; resource: { cpu: number; gpu: number; platform: string }; parallelism: number; image: string }[];
    }>('POST', '/api/workflows/validate', { yaml, overrides });
    expect(preview.ok, 'Deployed CPU image/runtime and parsed pipeline must be usable').toBe(true);
    expect(preview.order).toEqual(['train', 'evaluate']);
    expect(preview.vars).toMatchObject(overrides);
    expect(preview.preflight.projectId).toBe(researcher.project.id);
    expect(preview.preflight.status).toBe('needs-review');
    expect(preview.tasks).toHaveLength(2);
    for (const task of preview.tasks) {
      expect(task.resource.gpu).toBe(0);
      expect(task.resource.cpu).toBeGreaterThan(0);
      expect(task.resource.platform).toBe(pipeline.workflow.resources.cpu.platform);
      expect(task.parallelism).toBe(1);
      const approved = preview.preflight.tasks.find(item => item.task === task.name)!;
      expect(approved.profileId).toBeTruthy();
      expect(approved.profileVersion).toBeGreaterThan(0);
      expect(approved.findings.some(finding => finding.severity === 'error')).toBe(false);
      expect(approved.image.requestedImage).toBe(preview.vars.image);
      expect(task.image).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(task.image).toBe(approved.image.resolvedImage);
      expect(task.image).toBe(preview.preflight.resolvedImageDigests[task.name]);
      requireCondition(!!task.image && !task.image.startsWith('required://'), 'Deployed MUJOCO_IMAGE_URI is a prerequisite');
    }
    proofs.resources = preview.tasks;
    proofs.preflight = preview.preflight;
    const record: Researcher['runs'][number] = {
      name: pipeline.workflow.name, task: 'train', idempotencyKey: `model-pipeline-${researcher.tag}`,
    };
    researcher.runs.push(record); // Record intent BEFORE any possible submission.
    // Parent explicitly authorized this live run after image-profile bootstrap.
    // Acknowledge its recorded CPU preflight; this never approves model quality.
    const request = { yaml, overrides, templateId: recipe.id, templateVersion: recipe.templateVersion, acknowledgePreflight: true };
    const submit = () => researcher.api<PipelineRun>('POST', '/api/workflows', request, [202],
      remaining(budgets.api), { 'idempotency-key': record.idempotencyKey });
    let submitted: PipelineRun;
    try { submitted = await submit(); }
    catch {
      // Retry with the same key, never a new workflow. If both replies are lost,
      // recover only an exact name + project + owner match for fixture cleanup.
      try { submitted = await submit(); }
      catch (error) {
        const matches = (await researcher.api<Run[]>('GET', `/api/workflows?q=${encodeURIComponent(record.name)}`))
          .filter(run => run.name === record.name && run.projectId === researcher.project.id && run.ownerSubject === researcher.principal.subject);
        if (matches.length === 1) Object.assign(record, { id: matches[0].id, status: matches[0].status });
        throw error;
      }
    }
    requireCondition(/^[a-z0-9][a-z0-9-]{0,62}$/.test(submitted.id), 'Submission must return a safe workflow ID');
    record.id = submitted.id;
    record.status = submitted.status;
    proofs.runId = submitted.id;
    console.log(`[model-pipeline] run=${submitted.id} project=${researcher.project.id} episodes=${episodes}`);
    const detail: RunDetail = await researcher.poll('MuJoCo train/evaluate execution', remaining(budgets.workflow),
      timeout => researcher.detail(submitted.id, timeout),
      result => {
        requireCondition(!['FAILED', 'CANCELLED'].includes(result.workflow.status),
          `Own MuJoCo workflow ${submitted.id} ended ${result.workflow.status}`);
        return result.workflow.status === 'SUCCEEDED' && result.tasks.length === 2 && result.tasks.every(t => t.phase === 'SUCCEEDED');
      }, result => `${result.workflow.status}; ${result.tasks.map(t => `${t.name}:${t.phase}`).join(',')}`);
    const run = detail.workflow as PipelineRun;
    expect(run).toMatchObject({
      templateId: recipe.id, templateVersion: recipe.templateVersion, templateContentHash: recipe.contentHash, templateModified: true,
    });
    expect(run.specHash).toMatch(/^[a-f0-9]{64}$/);
    for (const task of run.spec.workflow.tasks) {
      const approved = preview.preflight.tasks.find(item => item.task === task.name)!;
      expect(task.image).toBe(preview.preflight.resolvedImageDigests[task.name]);
      expect(run.imagePins?.[task.name]).toMatchObject({
        image: task.image, profileId: approved.profileId, profileVersion: approved.profileVersion,
      });
    }
    const train = detail.tasks.find(t => t.name === 'train')!;
    const evaluate = detail.tasks.find(t => t.name === 'evaluate')!;
    const trainName = trainSpec.outputs[0].dataset.name.replaceAll('{{workflow_id}}', run.id);
    const evalName = evaluateSpec.outputs[0].dataset.name.replaceAll('{{workflow_id}}', run.id);
    expect(trainName).not.toBe(evalName);
    const trainVersion = await publication(researcher, run.id, train, trainName, remaining(60_000));
    const evalVersion = await publication(researcher, run.id, evaluate, evalName, remaining(60_000));
    proofs.publications = { train: trainVersion, evaluate: evalVersion };
    const trainManifest = await readManifest(researcher, trainVersion);
    const evalManifest = await readManifest(researcher, evalVersion);
    const bundles: Record<string, Bundle> = {};
    for (const path of ['initial', 'checkpoints/step-000000000256', 'checkpoints/step-000000000512', 'final']) {
      const bundle = await readPublishedJson<Bundle>(researcher, trainVersion, trainManifest, `${path}/manifest.json`);
      expect(bundle).toMatchObject({ schemaVersion: 1, algorithm: 'PPO', seed: 42, simulator: { name: 'MuJoCo' } });
      expect(bundle.simulator.sceneSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(bundle.simulator.menagerieCommit).toMatch(/^[a-f0-9]{40}$/);
      for (const file of ['model.zip', 'vecnormalize.pkl']) {
        const object = manifestObject(trainManifest, `${path}/${file}`);
        expect(bundle.sha256[file]).toBe(Buffer.from(object.checksumSHA256, 'base64').toString('hex'));
      }
      bundles[path] = bundle;
    }
    expect(bundles.initial.timesteps).toBe(0);
    expect(bundles.initial.updates).toBe(0);
    expect(bundles['checkpoints/step-000000000256'].timesteps).toBe(256);
    expect(bundles['checkpoints/step-000000000512'].timesteps).toBe(512);
    expect(bundles.final.timesteps).toBe(512);
    expect(bundles.final.updates).toBeGreaterThan(0);
    expect(bundles.final.normalization_count).toBeGreaterThan(bundles.initial.normalization_count);
    expect(bundles.final.sha256['model.zip']).not.toBe(bundles.initial.sha256['model.zip']);
    expect(bundles.final.sha256['vecnormalize.pkl']).not.toBe(bundles.initial.sha256['vecnormalize.pkl']);
    const training = await readPublishedJson<Bundle>(researcher, trainVersion, trainManifest, 'training.json');
    expect(training).toMatchObject({ ...bundles.final, initialTimesteps: 0, interrupted: false });
    for (const file of ['train.py', 'evaluate.py', 'common.py']) expect(training.sourceSha256[file]).toMatch(/^[a-f0-9]{64}$/);
    expect(training.packages.stable_baselines3).toBeTruthy();
    proofs.training = training;

    const model = await researcher.api<Model>('POST', '/api/models', {
      name: `E2E MuJoCo ${researcher.tag}`, dataset: trainName, version: trainVersion.version, checkpointPath: 'final/model.zip',
    });
    proofs.modelId = model.id;
    expect(model).toMatchObject({ projectId: researcher.project.id, ownerSubject: researcher.principal.subject });
    expect(model.id).toMatch(/^mdl-[a-f0-9]{24}$/);
    expect(model.qualityApproval).toBeUndefined();
    checkSource(model.source, trainVersion, train, run);
    expect(model.source.inputs).toEqual([]);
    expect(model.source.upstreamTasks).toEqual([]);
    expect(model.checkpoint.path).toBe('final/model.zip');
    checkPin(model.checkpoint, trainManifest, trainVersion);
    requireCondition(model.normalization && model.bundle, 'Registered model must retain its matched VecNormalize bundle');
    checkPin(model.normalization, trainManifest, trainVersion);
    checkPin(model.bundle.manifest, trainManifest, trainVersion);
    expect(model.bundle).toMatchObject({ path: 'final', seed: 42, task: training.task, simulator: training.simulator });
    expect(model.normalization.path).toBe('final/vecnormalize.pkl');
    expect(model.checkpoint.sha256).toBe(training.sha256['model.zip']);
    expect(model.normalization.sha256).toBe(training.sha256['vecnormalize.pkl']);
    proofs.model = model;

    const evaluation = await researcher.api<Evaluation>('POST', '/api/evaluations', {
      modelId: model.id, dataset: evalName, version: evalVersion.version, reportPath: 'evaluation.json',
    });
    proofs.evaluationId = evaluation.id;
    expect(evaluation).toMatchObject({
      modelId: model.id, projectId: researcher.project.id, ownerSubject: researcher.principal.subject,
      verification: 'published_runtime_report', inputMatch: 'same_run_task_output',
      task: training.task, seed: 2042, checkpointDigest: model.checkpoint.sha256, normalizationDigest: model.normalization.sha256,
    });
    checkSource(evaluation.source, evalVersion, evaluate, run);
    expect(evaluation.source.upstreamTasks).toEqual(['train']);
    expect(evaluation.report.path).toBe('evaluation.json');
    checkPin(evaluation.report, evalManifest, evalVersion);
    checkPin(evaluation.primaryVideo, evalManifest, evalVersion);
    const reportBytes = await readEvaluationArtifact(researcher, evaluation.id, 'report', evaluation.report);
    const report: Report = JSON.parse(reportBytes.toString('utf8'));
    expect(report).toMatchObject({
      schemaVersion: 1, type: 'closed_loop', task: training.task, seed: 2042,
      episodeCount: Number(episodes), checkpointDigest: model.checkpoint.sha256,
      normalizationDigest: model.normalization.sha256, simulator: training.simulator, timeoutSeconds: 10,
    });
    expect(report.episodes).toHaveLength(Number(episodes));
    for (const [index, episode] of report.episodes.entries()) {
      expect(episode.index).toBe(index);
      expect(episode.seed).toBe(2042 + index);
      expect(Number.isInteger(episode.steps) && episode.steps > 0).toBe(true);
      expect(Number.isFinite(episode.return)).toBe(true);
      nonnegative(episode.finalDistance);
      expect(typeof episode.success).toBe('boolean');
      expect(typeof episode.timeout).toBe('boolean');
      expect(episode.success).toBe(episode.finalDistance < 0.03);
      manifestObject(evalManifest, episode.videoUri);
    }
    expect(report.successCount).toBe(report.episodes.filter(episode => episode.success).length);
    expect(report.timeoutCount).toBe(report.episodes.filter(episode => episode.timeout).length);
    expect(report.successRate).toBe(report.successCount / report.episodeCount);
    for (const value of Object.values(report.latencyMs)) nonnegative(value);
    expect(report.latencyMs.p50).toBeLessThanOrEqual(report.latencyMs.p95);
    expect(report.latencyMs.p95).toBeLessThanOrEqual(report.latencyMs.p99);
    expect(evaluation).toMatchObject({
      metrics: { kind: 'simulation', episodes: report.episodeCount, successes: report.successCount, latencyP95Ms: report.latencyMs.p95 },
      successRate: report.successRate, timeoutCount: report.timeoutCount, latencyMs: report.latencyMs, simulator: report.simulator,
    });
    expect(evaluation.primaryVideo.path).toBe(report.videoUri);
    expect(report.videoUri).toBe(report.episodes[0].videoUri);
    expect(evalManifest.objects.filter(object => /^videos\/.*\.mp4$/.test(object.path))).toHaveLength(Number(episodes));
    const videoBytes = await readEvaluationArtifact(researcher, evaluation.id, 'video', evaluation.primaryVideo);
    expect(videoBytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    proofs.evaluation = evaluation;
    proofs.actualReport = report;
    proofs.downloads = {
      report: { versionId: evaluation.report.versionId, sha256: sha256(reportBytes), bytes: reportBytes.length },
      video: { versionId: evaluation.primaryVideo.versionId, sha256: sha256(videoBytes), bytes: videoBytes.length },
    };

    // Independent expected decision from actual validated measurements. Keeping
    // default thresholds and approve:false must not grant application approval.
    const expectedStatus = report.episodeCount < 20 ? 'review'
      : report.successRate < 0.8 || report.latencyMs.p95 > 100 ? 'fail' : 'pass';
    const gated = await researcher.api<{ model: Model; gate: Gate }>('POST', `/api/models/${model.id}/promotion`,
      { evaluationId: evaluation.id, approve: false });
    expect(gated.gate).toMatchObject({
      evaluationId: evaluation.id, approved: false,
      policy: { minimumEpisodes: 20, minimumSuccessRate: 0.8, maximumLatencyP95Ms: 100 },
      decision: { status: expectedStatus },
    });
    expect(gated.gate.decision.reasons.length).toBeGreaterThan(0);
    if (episodes === '2') {
      expect(gated.gate.decision.status).toBe('review');
      expect(gated.gate.decision.reasons).toContain('최소 20회 평가가 필요합니다.');
    } else {
      if (report.successRate < 0.8) expect(gated.gate.decision.reasons).toContain('작업 성공률이 기준보다 낮습니다.');
      if (report.latencyMs.p95 > 100) expect(gated.gate.decision.reasons).toContain('p95 추론 지연시간이 기준을 초과합니다.');
    }
    expect(gated.model.qualityApproval).toBeUndefined();
    const saved = await researcher.api<{ model: Model; evaluations: Evaluation[]; gates: Gate[] }>('GET', `/api/models/${model.id}`);
    expect(saved.model.qualityApproval).toBeUndefined();
    expect(saved.model.checkpoint).toEqual(model.checkpoint);
    expect(saved.evaluations).toContainEqual(evaluation);
    // Persisted history also includes its project scope; preserve every gate
    // field comparison without requiring private storage fields to disappear.
    expect(saved.gates).toContainEqual(expect.objectContaining({ ...gated.gate }));
    proofs.gate = gated.gate;
    console.log(`[model-pipeline] model=${model.id} evaluation=${evaluation.id} gate=${expectedStatus} approved=false`);

    await researcher.page.goto(`${researcher.origin}/models?model_id=${encodeURIComponent(model.id)}`,
      { waitUntil: 'domcontentloaded', timeout: remaining(budgets.api) });
    await expect(researcher.page.getByRole('heading', { name: model.name, exact: true })).toBeVisible({ timeout: remaining(budgets.api) });
    await expect(researcher.page.getByText('품질 미승인', { exact: true })).toBeVisible();
    const selectedEvaluation = researcher.page.getByRole('row').filter({
      has: researcher.page.getByRole('radio', { name: `${run.id} 평가 선택`, exact: true }),
    });
    await expect(selectedEvaluation).toContainText(`${report.successCount} / ${report.episodeCount}`);
    await expect(selectedEvaluation).toContainText(`${report.latencyMs.p95.toFixed(1)} ms`);
    const approval = researcher.page.getByRole('button', { name: '애플리케이션 품질 승인', exact: true });
    // History does not authorize a fresh browser action; check the default
    // criteria in this page before inspecting its approval-button state.
    await expect(approval).toBeDisabled();
    const promotionPath = `/api/models/${model.id}/promotion`;
    let blockedApproval = false;
    await researcher.page.route(`**${promotionPath}`, async route => {
      const body = route.request().postDataJSON() as { approve?: unknown; evaluationId?: string };
      if (body.approve !== false || body.evaluationId !== evaluation.id) {
        blockedApproval = true;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    try {
      const [response] = await Promise.all([
        researcher.page.waitForResponse(response =>
          new URL(response.url()).pathname === promotionPath && response.request().method() === 'POST',
        { timeout: remaining(budgets.api) }),
        researcher.page.getByRole('button', { name: '기준 확인', exact: true }).click(),
      ]);
      expect(response.status(), 'UI criteria check must persist a real gate').toBe(200);
      const uiResult = await response.json() as { gate: Gate; model: Model };
      expect(uiResult.gate).toMatchObject({
        evaluationId: evaluation.id, approved: false, policy: gated.gate.policy, decision: gated.gate.decision,
      });
      expect(uiResult.model.qualityApproval).toBeUndefined();
      proofs.uiGate = uiResult.gate;
    } finally {
      await researcher.page.unroute(`**${promotionPath}`);
      expect(blockedApproval, 'No browser action may approve a model').toBe(false);
    }
    if (expectedStatus === 'pass') await expect(approval).toBeEnabled();
    else await expect(approval).toBeDisabled();
    const gateStatus = researcher.page.getByRole('status').filter({
      hasText: { pass: '기준 통과', fail: '기준 미달', review: '검토 필요' }[expectedStatus],
    });
    await expect(gateStatus).toBeVisible();
    for (const reason of gated.gate.decision.reasons) await expect(gateStatus).toContainText(reason);
    const afterUI = await researcher.api<{ model: Model; gates: Gate[] }>('GET', `/api/models/${model.id}`);
    expect(afterUI.model.qualityApproval).toBeUndefined();
    expect(afterUI.gates.every(gate => !gate.approved)).toBe(true);
    await researcher.page.getByText('선택한 평가의 보고서·영상', { exact: true }).click();
    const video = researcher.page.locator('video[aria-label="첫 평가 에피소드 영상"]');
    await expect(video).toHaveAttribute('src', `/api/evaluations/${evaluation.id}/artifact?kind=video`);
    // Decode the already checksum-verified bytes locally. This avoids a second
    // signed URL in browser diagnostics or reliance on S3 media CORS configuration.
    await video.evaluate((element: HTMLVideoElement, base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      element.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      element.load();
    }, videoBytes.toString('base64'));
    try {
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth, height: element.videoHeight, playable: element.readyState >= 1 && element.duration > 0,
      })), { timeout: remaining(30_000) }).toEqual({ width: 160, height: 128, playable: true });
      proofs.videoDecode = await video.evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth, height: element.videoHeight, durationSeconds: element.duration,
      }));
    } finally {
      await video.evaluate((element: HTMLVideoElement) => { URL.revokeObjectURL(element.src); element.removeAttribute('src'); });
    }
    const experiments = await researcher.api<{ experiment_id: string; name: string }[]>('GET', '/api/mlflow/experiments');
    for (const experiment of experiments) expect(experiment.name.startsWith(`pai/${researcher.project.id}/`)).toBe(true);
    const [experimentResponse] = await Promise.all([
      researcher.page.waitForResponse(response => new URL(response.url()).pathname === '/api/mlflow/experiments',
        { timeout: remaining(budgets.api) }),
      researcher.page.goto(`${researcher.origin}/experiments`, { waitUntil: 'domcontentloaded', timeout: remaining(budgets.api) }),
    ]);
    expect(experimentResponse.status(), 'Browser cookie must select the same project tracking scope').toBe(200);
    const browserExperiments = await experimentResponse.json() as { name: string }[];
    for (const experiment of browserExperiments) expect(experiment.name.startsWith(`pai/${researcher.project.id}/`)).toBe(true);
    await expect(researcher.page.getByRole('heading', { name: '실험', exact: true })).toBeVisible({ timeout: remaining(budgets.api) });
    await expect(researcher.page.getByText(browserExperiments[0]?.name ?? '등록된 실험이 없습니다.', { exact: true }))
      .toBeVisible({ timeout: remaining(budgets.api) });
    // The MuJoCo builtin currently has mlflow:false; no fabricated tracking run.
    proofs.experiments = {
      projectScoped: true, apiCount: experiments.length, visibleCount: browserExperiments.length, pipelineMlflowEnabled: false,
    };
    proofs.liveOutcome = 'verified';
  } finally {
    // No cookies, credentials, presigned URLs, or raw HTTP errors in proof files.
    proofs.resourcesTracking = { runs: researcher.runs, datasets: researcher.datasets, phases: researcher.phases };
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath('model-pipeline-proof.json');
    await writeFile(path, JSON.stringify(proofs, null, 2));
    await info.attach('model-pipeline-proof', { path, contentType: 'application/json' });
  }
});
