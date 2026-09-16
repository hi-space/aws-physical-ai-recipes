import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canReadResource, resolveProject } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, HttpError, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import type { Write } from '../store/atomic';
import type { DatasetVersion, Task, Workflow } from '../store/types';
import type { TaskSpec } from '../workflow/schema';
import { digest, EvidenceReader, scopedS3, type ObjectStorage, type VerifiedSnapshot } from '../evaluations/evidence';
import { normalizeEvaluationReport, safeRelativePath, sha256Schema } from '../evaluations/report';
import { evaluatePromotion, type PromotionPolicy } from '../evaluations/promotion-policy';
import { S3EvidenceStorage } from '../evaluations/s3-storage';
import type {
  DatasetPin, GateRecord, LegacyModelsResponse, LegacySource, ModelDetail, ModelEvaluation, ModelsResponse,
  ObjectPin, PublishedOutput, RegisteredModel, SourceLineage,
} from '../evaluations/types';

export const DEFAULT_POLICY: PromotionPolicy = { minimumEpisodes: 20, minimumSuccessRate: 0.8, maximumLatencyP95Ms: 100 };
const datasetName = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(200);
const identifier = z.string().regex(/^[a-z0-9-]{1,100}$/);
export const registrationSchema = z.object({
  name: z.string().trim().min(1).max(120), dataset: datasetName,
  version: z.number().int().positive(), checkpointPath: z.string().min(1).max(2048),
}).strict();
export const ingestionSchema = z.object({
  modelId: identifier, dataset: datasetName, version: z.number().int().positive(),
  reportPath: z.string().max(2048).default('evaluation.json'),
}).strict();
export const policySchema = z.object({
  minimumEpisodes: z.number().int().min(1).max(100_000),
  minimumSuccessRate: z.number().finite().min(0).max(1),
  maximumLatencyP95Ms: z.number().finite().positive().max(3_600_000).optional(),
}).strict();
export const promotionSchema = z.object({
  evaluationId: identifier, policy: policySchema.default(DEFAULT_POLICY), approve: z.boolean().default(false),
}).strict();

interface Published {
  version: DatasetVersion;
  workflow: Workflow;
  task: Task;
  spec: TaskSpec;
}
interface Dependencies {
  repo: Repo;
  objects: ObjectStorage;
  artifactBucket: string;
  now?: () => Date;
  legacy?: () => Promise<LegacySource[]>;
}
const principal = (session: Session) => session.subject ?? session.user;
const strip = <T>(item: Item): T => {
  const { pk: _pk, sk: _sk, gsi1pk: _gsi1pk, gsi1sk: _gsi1sk, ...record } = item;
  return record as T;
};
const modelKey = (project: string, id: string) => ({ pk: `MODEL#${project}#${id}`, sk: 'META' });
const evaluationKey = (project: string, id: string) => ({ pk: `EVALUATION#${project}#${id}`, sk: 'META' });
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest('Invalid model/evaluation request', { issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  return result.data;
}
function modelItem(model: RegisteredModel): Item {
  return { ...model, ...modelKey(model.projectId, model.id), gsi1pk: `PROJECT#${model.projectId}#MODELS`, gsi1sk: `${model.createdAt}#${model.id}` };
}
function sourceChecks(published: Published): Write[] {
  const v = published.version;
  return [
    { kind: 'check', pk: `DS#${v.dataset}`, sk: `V#${String(v.version).padStart(6, '0')}`,
      condition: { equals: { projectId: v.projectId!, state: 'READY', uri: v.uri, manifestUri: v.manifestUri!, manifestHash: v.manifestHash!, producedAttempt: v.producedAttempt! } } },
    { kind: 'check', pk: `WF#${published.workflow.id}`, sk: `TASK#${published.task.name}`,
      condition: { equals: { phase: 'SUCCEEDED', attempts: published.task.attempts } } },
    { kind: 'check', pk: `WF#${published.workflow.id}`, sk: 'META',
      condition: { equals: { projectId: v.projectId!, ...(published.workflow.specHash ? { specHash: published.workflow.specHash } : {}) } } },
  ];
}
const isCheckpoint = (path: string) => /\.(zip|pt|pth|safetensors|bin|ckpt|tar\.gz)$/i.test(path) && !/vecnormalize/i.test(path);
const hasReceipt = (task: Task, version: DatasetVersion) =>
  task.publishedVersions?.some(v => v.dataset === version.dataset && v.version === version.version) &&
  Object.values(task.artifactReceipts ?? {}).some(r => r.uri === version.uri && r.manifestUri === version.manifestUri && r.manifestHash === version.manifestHash);

/** All public methods authorize the project, including read-only calls and direct service use. */
export class ModelsService {
  private readonly evidence: EvidenceReader;
  constructor(private readonly deps: Dependencies) {
    this.evidence = new EvidenceReader(deps.objects, deps.artifactBucket);
  }
  private timestamp() { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private async access(session: Session, projectId: string, write = false) {
    validate(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), projectId);
    if (write) requireRole(session, 'researcher');
    return resolveProject(session, projectId, this.deps.repo, write ? 'researcher' : 'viewer');
  }
  private canWrite(session: Session, members: Record<string, string>) {
    return session.role === 'admin' || session.role === 'researcher' && ['researcher', 'project-admin'].includes(members[principal(session)]);
  }
  private async model(projectId: string, id: string) {
    validate(identifier, id);
    const item = await this.deps.repo.kv.get(modelKey(projectId, id).pk, 'META');
    if (!item || item.projectId !== projectId || item.id !== id) throw notFound('model');
    return strip<RegisteredModel>(item);
  }
  private async published(session: Session, projectId: string, dataset: string, version: number): Promise<Published> {
    validate(datasetName, dataset); validate(z.number().int().positive(), version);
    const [ds, v] = await Promise.all([this.deps.repo.getDataset(dataset), this.deps.repo.getVersion(dataset, version)]);
    if (!ds || ds.projectId !== projectId || !v || v.projectId !== projectId) throw notFound('published dataset version');
    if (v.state !== 'READY' || !v.producedBy || !v.producedAttempt || !v.manifestHash || !v.manifestUri) throw badRequest('Register only READY outputs published by a completed workflow task');
    const workflow = await this.deps.repo.getWorkflow(v.producedBy.workflowId);
    if (!workflow || workflow.projectId !== projectId || !(await canReadResource(session, workflow, this.deps.repo))) throw notFound('source workflow');
    const tasks = await this.deps.repo.listTasks(workflow.id);
    const task = tasks.find(t => t.name === v.producedBy!.task);
    const spec = workflow.spec.workflow.tasks.find(t => t.name === v.producedBy!.task);
    if (!task || !spec) throw notFound('source task');
    if (task.phase !== 'SUCCEEDED' || task.ignoredByGroupPolicy || task.attempts !== v.producedAttempt || !hasReceipt(task, v)) throw badRequest('Source task has no matching successful publication receipt for this attempt');
    return { version: v, workflow, task, spec };
  }
  private lineage(p: Published, dataset: DatasetPin): SourceLineage {
    const inputs = new Map<string, SourceLineage['inputs'][number]>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      for (const snapshot of Object.values(p.workflow.datasetSnapshots?.[name] ?? {})) {
        if (!snapshot.manifestHash || !sha256Schema.safeParse(snapshot.manifestHash).success) throw badRequest('Source input lineage is not pinned to a manifest');
        scopedS3(snapshot.uri, p.workflow.projectId!, this.deps.artifactBucket);
        inputs.set(`${snapshot.name}:${snapshot.version}:${snapshot.manifestHash}`, {
          name: snapshot.name, version: snapshot.version, uri: snapshot.uri, manifestHash: snapshot.manifestHash,
        });
      }
      for (const input of p.workflow.spec.workflow.tasks.find(t => t.name === name)?.inputs ?? []) if ('task' in input) visit(input.task);
    };
    visit(p.task.name);
    return { workflowId: p.workflow.id, task: p.task.name, attempt: p.task.attempts, image: p.spec.image,
      workflowSpecHash: p.workflow.specHash ?? digest(JSON.stringify(p.workflow.spec)), dataset,
      inputs: [...inputs.values()], upstreamTasks: [...visited].filter(name => name !== p.task.name) };
  }
  async list(session: Session, projectId: string, cursor?: string): Promise<ModelsResponse> {
    const project = await this.access(session, projectId);
    const [page, datasets] = await Promise.all([
      this.deps.repo.kv.queryGsi1Page(`PROJECT#${projectId}#MODELS`, { limit: 50, desc: true, cursor }),
      this.deps.repo.listDatasets(),
    ]);
    const candidates = datasets.filter(d => d.projectId === projectId).slice(0, 100);
    const versions: DatasetVersion[] = [];
    let truncatedVersions = false;
    for (let offset = 0; offset < candidates.length; offset += 8) {
      const batch = await Promise.all(candidates.slice(offset, offset + 8).map(ds => this.deps.repo.listVersions(ds.name)));
      for (const values of batch) {
        const ready = values.filter(v => v.projectId === projectId && v.state === 'READY' && v.producedBy);
        truncatedVersions ||= ready.length > 10;
        versions.push(...ready.slice(0, 10));
      }
    }
    const outputs: PublishedOutput[] = [];
    const limited = versions.slice(0, 100);
    for (let offset = 0; offset < limited.length; offset += 8) {
      const batch = await Promise.all(limited.slice(offset, offset + 8).map(async v => {
        try {
          const published = await this.published(session, projectId, v.dataset, v.version);
          return { dataset: v.dataset, version: v.version, workflowId: published.workflow.id, task: published.task.name, createdAt: v.createdAt };
        } catch (error) {
          if (!(error instanceof HttpError && [400, 404].includes(error.status))) throw error;
          return undefined;
        }
      }));
      outputs.push(...batch.filter((value): value is PublishedOutput => value !== undefined));
    }
    return { projectId, canWrite: this.canWrite(session, project.members),
      models: page.items.filter(i => i.projectId === projectId).map(i => strip<RegisteredModel>(i)),
      outputs, cursor: page.cursor, outputLimitReached: datasets.filter(d => d.projectId === projectId).length > 100 || versions.length > 100 || truncatedVersions,
      defaultPolicy: DEFAULT_POLICY };
  }
  async output(session: Session, projectId: string, dataset: string, version: number) {
    await this.access(session, projectId);
    const published = await this.published(session, projectId, dataset, version);
    const snapshot = await this.evidence.snapshot(projectId, published.version);
    return { source: this.lineage(published, snapshot.dataset), files: [...snapshot.objects.values()]
      .filter(file => isCheckpoint(file.path) || /(^|\/)evaluation\.json$/.test(file.path)).map(file => ({
      ...file, kind: isCheckpoint(file.path) ? 'checkpoint' as const : /(^|\/)evaluation\.json$/.test(file.path) ? 'evaluation' as const : 'artifact' as const,
    })) };
  }
  async get(session: Session, projectId: string, id: string): Promise<ModelDetail> {
    const project = await this.access(session, projectId);
    const model = await this.model(projectId, id);
    const [evaluations, gates] = await Promise.all([
      this.deps.repo.kv.query(modelKey(projectId, id).pk, 'EVALUATION#', { desc: true, limit: 100 }),
      this.deps.repo.kv.query(modelKey(projectId, id).pk, 'GATE#', { desc: true, limit: 100 }),
    ]);
    return { model, canWrite: this.canWrite(session, project.members),
      evaluations: evaluations.filter(i => i.projectId === projectId).map(i => strip<ModelEvaluation>(i)),
      gates: gates.map(i => strip<GateRecord>(i)) };
  }
  async register(session: Session, projectId: string, input: unknown): Promise<RegisteredModel> {
    await this.access(session, projectId, true);
    const request = validate(registrationSchema, input);
    if (!isCheckpoint(request.checkpointPath)) throw badRequest('Select a checkpoint file from the published output');
    const source = await this.published(session, projectId, request.dataset, request.version);
    const snapshot = await this.evidence.snapshot(projectId, source.version);
    const checkpoint = await this.evidence.verify(this.evidence.select(snapshot, request.checkpointPath));
    if (checkpoint.bytes <= 0) throw badRequest('Checkpoint is empty');
    const id = `mdl-${digest(`${projectId}:${snapshot.dataset.manifestHash}:${checkpoint.key}:${checkpoint.versionId}`).slice(0, 24)}`;
    const existing = await this.deps.repo.kv.get(modelKey(projectId, id).pk, 'META');
    if (existing) return strip<RegisteredModel>(existing);
    const model: RegisteredModel = { id, name: request.name, projectId, ownerSubject: principal(session),
      createdAt: this.timestamp(), revision: 1, source: this.lineage(source, snapshot.dataset), checkpoint };
    await this.mujocoBundle(model, snapshot);
    if (!checkpoint.sha256) model.evaluationUnavailableReason = 'Full-object SHA256 is unavailable for this multipart checkpoint; the composite checksum cannot verify a report checkpointDigest.';
    else if (!model.bundle) model.evaluationUnavailableReason = 'No verified compatible evaluation-launch profile for this checkpoint. Published reports must still match the pinned file digest and source snapshot.';
    const committed = await this.deps.repo.kv.transaction([
      ...sourceChecks(source), { kind: 'put', item: modelItem(model), condition: { absent: true } },
    ]);
    if (!committed) {
      const duplicate = await this.deps.repo.kv.get(modelKey(projectId, id).pk, 'META');
      if (duplicate) return strip<RegisteredModel>(duplicate);
      throw new HttpError(409, 'Source publication changed during registration; reload the output');
    }
    return model;
  }
  private async mujocoBundle(model: RegisteredModel, snapshot: VerifiedSnapshot) {
    const path = model.checkpoint.path;
    if (!path.endsWith('/model.zip') || !model.checkpoint.sha256) return;
    const folder = path.slice(0, -'/model.zip'.length);
    const manifest = snapshot.objects.get(folder + '/manifest.json');
    if (!manifest) return;
    const schema = z.object({
      schemaVersion: z.literal(1), algorithm: z.literal('PPO'), task: z.literal('Workshop-SO101-Reach-MuJoCo-v0'),
      seed: z.number().int().nonnegative(), sha256: z.object({ 'model.zip': sha256Schema, 'vecnormalize.pkl': sha256Schema }),
      simulator: z.record(z.string(), z.string()).refine(v => v.name === 'MuJoCo' && Boolean(v.version && v.sceneSha256)),
    });
    const bundle = validate(schema, await this.evidence.json(manifest, 256 * 1024));
    const normalization = await this.evidence.verify(this.evidence.select(snapshot, folder + '/vecnormalize.pkl'));
    if (bundle.sha256['model.zip'] !== model.checkpoint.sha256 || bundle.sha256['vecnormalize.pkl'] !== normalization.sha256) throw badRequest('Checkpoint bundle model/normalization digest mismatch');
    model.normalization = normalization;
    model.bundle = { path: folder, manifest, task: bundle.task, seed: bundle.seed, simulator: bundle.simulator };
    const query = new URLSearchParams({ template: 'mujoco-render', model_id: model.id, dataset_name: model.source.dataset.name,
      dataset_version: String(model.source.dataset.version), checkpoint_bundle: folder, episodes: '20', eval_seed: '2042' });
    model.evaluationLaunch = { template: 'mujoco-render', href: `/workflows/new?${query}` };
  }
  private async matchInput(model: RegisteredModel, source: Published): Promise<ModelEvaluation['inputMatch']> {
    const expected = model.source.dataset;
    for (const [index, input] of source.spec.inputs.entries()) {
      if ('dataset' in input) {
        const snapshot = source.workflow.datasetSnapshots?.[source.task.name]?.[index];
        if (input.dataset.name === expected.name && (input.dataset.version === 'latest' || input.dataset.version === expected.version) &&
            snapshot?.name === expected.name && snapshot.version === expected.version &&
            snapshot.uri === expected.uri && snapshot.manifestHash === expected.manifestHash) return 'dataset_snapshot';
      } else if (source.workflow.id === model.source.workflowId && input.task === model.source.task) {
        const producer = (await this.deps.repo.listTasks(source.workflow.id)).find(t => t.name === input.task);
        if (producer?.phase === 'SUCCEEDED' && producer.attempts === model.source.attempt &&
            producer.publishedVersions?.some(v => v.dataset === expected.name && v.version === expected.version) &&
            Object.values(producer.artifactReceipts ?? {}).some(r => r.manifestUri === expected.manifestUri && r.manifestHash === expected.manifestHash && r.uri === expected.uri)) return 'same_run_task_output';
      }
    }
    throw badRequest('Evaluation input snapshot does not match the registered model source');
  }
  async ingest(session: Session, projectId: string, input: unknown): Promise<ModelEvaluation> {
    await this.access(session, projectId, true);
    const request = validate(ingestionSchema, input);
    const model = await this.model(projectId, request.modelId);
    if (!model.checkpoint.sha256) throw badRequest('A full-object checkpoint SHA256 is required to verify this evaluation');
    const source = await this.published(session, projectId, request.dataset, request.version);
    const inputMatch = await this.matchInput(model, source);
    const snapshot = await this.evidence.snapshot(projectId, source.version);
    if (!/(^|\/)evaluation\.json$/.test(safeRelativePath(request.reportPath))) throw badRequest('Select the published evaluation.json report');
    const report = this.evidence.select(snapshot, request.reportPath);
    const normalized = normalizeEvaluationReport(await this.evidence.json(report));
    if (normalized.checkpointDigest !== model.checkpoint.sha256) throw badRequest('Evaluation checkpoint digest does not match the registered model');
    if (model.normalization && normalized.normalizationDigest !== model.normalization.sha256) throw badRequest('Evaluation normalization digest does not match the registered bundle');
    if (normalized.normalizationDigest && !model.normalization) throw badRequest('Report normalization digest has no verified model bundle');
    if (model.bundle && (normalized.task !== model.bundle.task ||
        normalized.simulator.sceneSha256 !== model.bundle.simulator.sceneSha256 ||
        normalized.simulator.version !== model.bundle.simulator.version ||
        normalized.simulator.name !== model.bundle.simulator.name)) throw badRequest('Evaluation task/simulator/scene does not match the model bundle');
    const reportFolder = report.path.includes('/') ? report.path.slice(0, report.path.lastIndexOf('/') + 1) : '';
    const videos = normalized.videoPaths.map(path => this.evidence.select(snapshot, reportFolder + path));
    if (videos.some(v => !v.bytes || !/\.mp4$/i.test(v.path))) throw badRequest('Report references missing/empty published MP4 video');
    const primaryVideo = await this.evidence.verify(videos[0]);
    const id = `eval-${digest(`${model.id}:${snapshot.dataset.manifestHash}:${report.key}:${report.versionId}`).slice(0, 24)}`;
    const previous = await this.deps.repo.kv.get(evaluationKey(projectId, id).pk, 'META');
    if (previous) return strip<ModelEvaluation>(previous);
    const { videoPaths: _paths, ...summary } = normalized;
    const evaluation: ModelEvaluation = { ...summary, id, modelId: model.id, projectId, ownerSubject: principal(session),
      createdAt: this.timestamp(), verification: 'published_runtime_report', source: this.lineage(source, snapshot.dataset),
      report, primaryVideo, inputMatch };
    const committed = await this.deps.repo.kv.transaction([
      ...sourceChecks(source),
      { kind: 'put', item: { ...evaluation, ...evaluationKey(projectId, id) }, condition: { absent: true } },
      { kind: 'put', item: { ...evaluation, pk: modelKey(projectId, model.id).pk, sk: `EVALUATION#${evaluation.createdAt}#${id}` }, condition: { absent: true } },
    ]);
    if (!committed) {
      const duplicate = await this.deps.repo.kv.get(evaluationKey(projectId, id).pk, 'META');
      if (duplicate) return strip<ModelEvaluation>(duplicate);
      throw new HttpError(409, 'Evaluation publication changed during ingestion');
    }
    return evaluation;
  }
  async getEvaluation(session: Session, projectId: string, id: string): Promise<ModelEvaluation> {
    await this.access(session, projectId); validate(identifier, id);
    const item = await this.deps.repo.kv.get(evaluationKey(projectId, id).pk, 'META');
    if (!item || item.projectId !== projectId || item.id !== id) throw notFound('evaluation');
    const evaluation = strip<ModelEvaluation>(item);
    await this.model(projectId, evaluation.modelId);
    return evaluation;
  }
  async promote(session: Session, projectId: string, modelId: string, input: unknown) {
    await this.access(session, projectId, true);
    const request = validate(promotionSchema, input);
    const [model, evaluation] = await Promise.all([this.model(projectId, modelId), this.getEvaluation(session, projectId, request.evaluationId)]);
    if (evaluation.modelId !== modelId || evaluation.verification !== 'published_runtime_report' ||
        evaluation.checkpointDigest !== model.checkpoint.sha256) throw badRequest('Evaluation is not verified for this model');
    const decision = evaluatePromotion(evaluation.metrics, request.policy);
    if (request.approve && decision.status !== 'pass') throw badRequest('Quality approval requires a passing verified evaluation', { decision });
    const gate: GateRecord = { id: `gate-${randomUUID()}`, evaluationId: evaluation.id, policy: request.policy,
      decision, approved: request.approve, createdAt: this.timestamp(), ownerSubject: principal(session) };
    const updated = { ...model, revision: model.revision + 1, lastGate: gate, ...(request.approve ? { qualityApproval: gate } : {}) };
    if (!(await this.deps.repo.kv.transaction([
      { kind: 'put', item: modelItem(updated), condition: { equals: { revision: model.revision, projectId } } },
      { kind: 'put', item: { ...gate, projectId, pk: modelKey(projectId, modelId).pk, sk: `GATE#${gate.createdAt}#${gate.id}` }, condition: { absent: true } },
    ]))) throw new HttpError(409, 'Model approval changed concurrently; reload before applying this decision');
    return { model: updated, gate };
  }
  async artifact(session: Session, projectId: string, evaluationId: string, kind: 'report' | 'video') {
    const evaluation = await this.getEvaluation(session, projectId, evaluationId);
    const object: ObjectPin = kind === 'report' ? evaluation.report : evaluation.primaryVideo;
    scopedS3(`s3://${object.bucket}/${object.key}`, projectId, this.deps.artifactBucket);
    await this.evidence.verify(object);
    return this.deps.objects.presign(object);
  }
  async legacy(session: Session, projectId: string): Promise<LegacyModelsResponse> {
    requireRole(session, 'admin');
    await this.access(session, projectId);
    return { approvalMeaning: 'smoke_only', sources: await (this.deps.legacy ?? loadLegacySources)() };
  }
}

/** Explicit, read-only admin browsing. Each source keeps its own failure state. */
async function loadLegacySources(): Promise<LegacySource[]> {
  const [{ config }, storage, sm, ml] = await Promise.all([
    import('../config'), import('../aws/s3'), import('../aws/sagemaker'), import('../aws/mlflow'),
  ]);
  const c = config();
  const read = async (name: string, enabled: boolean, operation: () => Promise<unknown>): Promise<LegacySource> => {
    if (!enabled) return { name, status: 'not_configured' };
    try { return { name, status: 'ok', data: await operation() }; }
    catch (error) {
      console.error('[models] legacy source failed', name, (error as Error).name);
      return { name, status: 'error', error: `${name} 조회에 실패했습니다. 소스 권한과 연결 상태를 확인하세요.` };
    }
  };
  return Promise.all([
    read('SageMaker artifacts', Boolean(c.groot?.artifactsBucket), () => storage.list(c.groot!.artifactsBucket, 'models/groot-sm/')),
    read('EKS checkpoints', Boolean(c.eks?.dataBucket), () => storage.list(c.eks!.dataBucket, 'checkpoints/')),
    read('SageMaker registry', Boolean(c.groot?.modelPackageGroup), () => sm.listModelPackages()),
    read('MLflow models', Boolean(c.groot?.mlflowTrackingServerArn), () => ml.searchRegisteredModels()),
  ]);
}

export function modelsService() {
  const bucket = process.env.DASHBOARD_ARTIFACT_BUCKET;
  // No network operation during construction; legacy browsing can still report missing configuration.
  return new ModelsService({ repo: getRepo(), objects: new S3EvidenceStorage(), artifactBucket: bucket ?? '' });
}
