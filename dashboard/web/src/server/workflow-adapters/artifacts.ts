import {
  CreateDataRepositoryTaskCommand, DescribeDataRepositoryTasksCommand, DescribeDataRepositoryAssociationsCommand,
  type DataRepositoryAssociation,
} from '@aws-sdk/client-fsx';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { fsx, s3 } from '../aws/clients';
import { backendConfig as config } from '../backends/context';
import { currentBackend, runOnBackend, assertBackendReady } from '../backends/context';
import { backendId } from '../backends/registry';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import { TERMINAL_WF, type Workflow } from '../store/types';
import type { ControllerDeps } from '../workflow/controller';
import { sha256, snapshotPrefix, SnapshotPendingError, type SnapshotManifest } from '../storage/snapshots';
import { k8sJson, k8sRequest } from '../k8s/client';
import type { Job, Pod, K8sList } from '../k8s/resources';
import {
  INVENTORY_LIMIT, assertInventoryJob, inventoryFence, inventoryIdentity, inventoryJob, inventoryLabels,
  inventoryName, inventoryRecord, parseInventory, successfulInventoryPod, validateInventoryScope,
  type ArtifactInventory, type InventoryScope,
} from './artifact-inventory';
type Publisher = NonNullable<ControllerDeps['artifactPublisher']>;
type PublishInput = Parameters<Publisher['publish']>[0];

export function publicationPrefix(input: Pick<PublishInput, 'workflow' | 'task' | 'attempt' | 'publicationId'>) {
  const project = input.workflow.projectId ?? 'legacy';
  for (const part of [project, input.workflow.id, input.task.name]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part)) throw new Error('Invalid artifact identity');
  }
  return `projects/${project}/runs/${input.workflow.id}/attempts/${input.attempt}/${input.task.name}/${sha256(input.publicationId)}/`;
}
function ready(bucket: string, prefix: string, manifest: SnapshotManifest, hash: string) {
  return {
    state: 'ready' as const, uri: `s3://${bucket}/${prefix}`,
    manifestUri: `s3://${bucket}/${prefix}manifest.json`, manifestHash: hash,
    verifiedAt: manifest.createdAt, objectCount: manifest.objects.length,
    sizeBytes: manifest.objects.reduce((sum, object) => sum + object.bytes, 0),
  };
}
const pending = (message: string) => ({ state: 'pending' as const, message });
const notFound = (error: unknown) => (error as { status?: number }).status === 404 ||
  ['NoSuchKey', 'NotFound'].includes((error as Error).name);
const jobPath = (ns: string, name?: string) => `/apis/batch/v1/namespaces/${ns}/jobs${name ? `/${name}` : ''}`;
const podPath = (ns: string, name?: string) => `/api/v1/namespaces/${ns}/pods${name ? `/${name}` : ''}`;
const k8sSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
// Covers the bounded client request plus API server create processing. Kubernetes
// apiserver release-1.33/pkg/endpoints/handlers/create.go caps create handling at
// 34s. A create must start within 30s of its intent; no second create is issued
// during this window, even when the first response was lost.
const CREATE_WINDOW_MS = 120_000;
async function getJob(ns: string, name: string, signal: AbortSignal) {
  try { return await k8sJson<Job>(jobPath(ns, name), { signal: k8sSignal(signal) }); }
  catch (error) { if (notFound(error)) return null; throw error; }
}
async function all<T>(path: string, selector: string, signal: AbortSignal): Promise<T[]> {
  const values: T[] = []; const seen = new Set<string>(); let token: string | undefined;
  do {
    const query = new URLSearchParams({ labelSelector: selector, limit: '200', ...(token ? { continue: token } : {}) });
    const page: K8sList<T> = await k8sJson(`${path}?${query}`, { signal: k8sSignal(signal) });
    values.push(...page.items); token = page.metadata?.continue;
    if (token && seen.has(token)) throw new Error('Repeated collector pagination token');
    if (token) seen.add(token);
  } while (token);
  return values;
}
async function boundedText(body: unknown, limit = INVENTORY_LIMIT) {
  const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  if (!stream?.[Symbol.asyncIterator]) throw new Error('Inventory must be a bounded stream');
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new Error('Inventory exceeds bounded log limit');
      chunks.push(Buffer.from(chunk));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { stream.destroy?.(); }
}

async function assertCurrent(repo: Repo, input: PublishInput) {
  input.signal.throwIfAborted();
  validateInventoryScope(input);
  const wf = await repo.getWorkflow(input.workflow.id);
  if (!wf || wf.projectId !== input.workflow.projectId || wf.namespace !== input.workflow.namespace ||
      TERMINAL_WF.has(wf.status) || wf.status === 'CANCELLING') throw new Error('Artifact workflow is cancelled or superseded');
  // No raw-exit constraint: a legitimate COMPLETE policy can map application exit 7.
  if (!(await repo.kv.transaction(currentChecks(input)))) throw new Error('Artifact attempt is fenced, cancelled or superseded');
  input.signal.throwIfAborted();
}
function currentChecks(input: PublishInput) {
  return [
    { kind: 'check' as const, pk: `WF#${input.workflow.id}`, sk: `TASK#${input.task.name}`, condition: {
      equals: { attempts: input.attempt, phase: 'FINALIZING', outputPath: input.task.outputPath,
        ...(input.task.attemptEpoch ? { attemptEpoch: input.task.attemptEpoch } : {}) },
    } },
    { kind: 'check' as const, pk: `WF#${input.workflow.id}`, sk: 'CANCEL', condition: { absent: true as const } },
    { kind: 'check' as const, ...inventoryFence(input.workflow.id, input.task.name, input.attempt), condition: { absent: true as const } },
  ];
}

interface CollectorRecord extends Item {
  identity: string; workflowId: string; projectId: string; namespace: string; taskName: string;
  attempt: number; publicationId: string; sourcePath: string; image: string; name: string;
  creationDeadline: number; createIssued: boolean; jobUid?: string; epoch?: string; revision: number;
  inventoryKey?: string; inventoryVersion?: string; inventorySHA256?: string;
}
function checkRecord(record: CollectorRecord, input: InventoryScope) {
  if (record.identity !== inventoryIdentity(input) || record.sourcePath !== input.sourcePath ||
      record.workflowId !== input.workflow.id || record.projectId !== input.workflow.projectId ||
      record.namespace !== input.workflow.namespace || record.attempt !== input.attempt ||
      record.taskName !== input.task.name || record.name !== inventoryName(input) ||
      record.epoch !== input.task.attemptEpoch) throw new Error('Collector record scope mismatch');
}
async function updateRecord(repo: Repo, input: PublishInput, record: CollectorRecord, patch: Partial<CollectorRecord>) {
  const next = { ...record, ...patch, revision: record.revision + 1 };
  if (!await repo.kv.transaction([...currentChecks(input), {
    kind: 'put', item: next, condition: { equals: { revision: record.revision } },
  }])) throw new Error('Collector record changed or was fenced');
  return next;
}

async function cleanupCollector(input: InventoryScope, record: CollectorRecord, signal: AbortSignal) {
  checkRecord(record, input);
  const { namespace, name } = record;
  const job = await getJob(namespace, name, signal);
  if (job) {
    assertInventoryJob(job, input, record.image);
    if (record.jobUid && job.metadata.uid !== record.jobUid) throw new Error('Collector Job UID changed');
    await k8sJson(jobPath(namespace, name), { method: 'DELETE', signal: k8sSignal(signal),
      body: { propagationPolicy: 'Foreground', preconditions: { uid: job.metadata.uid } } })
      .catch(error => { if (!notFound(error)) throw error; });
  }
  const selector = `pai.aws/publication=${name},pai.aws/workflow-id=${input.workflow.id}`;
  const pods = await all<Pod>(podPath(namespace), selector, signal);
  for (const pod of pods) {
    if (Object.entries(inventoryLabels(input)).some(([key, value]) => pod.metadata.labels?.[key] !== value)) throw new Error('Collector Pod scope mismatch');
    const owners = (pod.metadata as Pod['metadata'] & { ownerReferences?: { uid: string; controller?: boolean }[] }).ownerReferences;
    if (!pod.metadata.uid || !owners?.some(owner => owner.controller && owner.uid === (job?.metadata.uid ?? record.jobUid))) {
      throw new Error('Collector Pod ownership is not verified');
    }
    await k8sJson(podPath(namespace, pod.metadata.name), { method: 'DELETE', signal: k8sSignal(signal),
      body: { gracePeriodSeconds: 5, preconditions: { uid: pod.metadata.uid } } })
      .catch(error => { if (!notFound(error)) throw error; });
  }
  // An intent may precede a lost POST reply. Wait its bounded create window even
  // if a list is momentarily empty, so cancellation cannot miss an in-flight Job.
  if (!record.jobUid && record.creationDeadline > Date.now()) return false;
  return !await getJob(namespace, name, signal) &&
    (await all<Pod>(podPath(namespace), selector, signal)).length === 0;
}

async function readSavedInventory(bucket: string, record: CollectorRecord, signal: AbortSignal) {
  if (!record.inventoryKey || !record.inventoryVersion || record.inventoryVersion === 'null' || !record.inventorySHA256) throw new Error('Inventory pin is incomplete');
  const response = await s3().send(new GetObjectCommand({
    Bucket: bucket, Key: record.inventoryKey, VersionId: record.inventoryVersion, ChecksumMode: 'ENABLED',
  }), { abortSignal: signal });
  if (response.VersionId !== record.inventoryVersion || (response.ContentLength ?? Infinity) > INVENTORY_LIMIT) throw new Error('Inventory version/size mismatch');
  const text = await boundedText(response.Body);
  if (sha256(text) !== record.inventorySHA256) throw new Error('Inventory digest mismatch');
  return parseInventory(text, record.identity);
}

async function collectInventory(input: PublishInput, bucket: string, prefix: string): Promise<ArtifactInventory | undefined> {
  const repo = getRepo(); const key = inventoryRecord(input);
  await assertCurrent(repo, input);
  let record = await repo.kv.get(key.pk, key.sk) as CollectorRecord | undefined;
  if (!record) {
    const image = process.env.MUJOCO_IMAGE_URI ?? '';
    inventoryJob(input, image);
    const candidate: CollectorRecord = { ...key, identity: inventoryIdentity(input), workflowId: input.workflow.id,
      projectId: input.workflow.projectId!, namespace: input.workflow.namespace, taskName: input.task.name,
      attempt: input.attempt, publicationId: input.publicationId, sourcePath: input.sourcePath, image,
      name: inventoryName(input), creationDeadline: 0, createIssued: false, epoch: input.task.attemptEpoch, revision: 0 };
    if (!await repo.kv.transaction([...currentChecks(input), { kind: 'put', item: candidate, condition: { absent: true } }])) {
      await assertCurrent(repo, input);
    }
    record = await repo.kv.get(key.pk, key.sk) as CollectorRecord | undefined;
    if (!record) throw new Error('Collector creation intent was not committed');
  }
  checkRecord(record, input);
  if (record.inventoryKey) {
    const inventory = await readSavedInventory(bucket, record, input.signal);
    await assertCurrent(repo, input);
    return await cleanupCollector(input, record, input.signal) ? inventory : undefined;
  }
  let job = await getJob(record.namespace, record.name, input.signal);
  if (!job) {
    if (record.jobUid) throw new Error('Collector disappeared before its inventory was saved');
    if (record.createIssued && record.creationDeadline > Date.now()) return undefined;
    // Record the bounded create window atomically with the attempt fence.
    record = await updateRecord(repo, input, record, { creationDeadline: Date.now() + CREATE_WINDOW_MS, createIssued: true });
    await assertCurrent(repo, input);
    if (Date.now() >= record.creationDeadline - CREATE_WINDOW_MS + 30_000) throw new Error('Collector creation window expired');
    try { job = await k8sJson<Job>(jobPath(record.namespace), {
      method: 'POST', body: inventoryJob(input, record.image), signal: k8sSignal(input.signal),
    }); } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      job = await getJob(record.namespace, record.name, input.signal);
    }
    if (!job) throw new Error('Collector creation could not be confirmed');
  }
  assertInventoryJob(job, input, record.image);
  if (record.jobUid && job.metadata.uid !== record.jobUid) throw new Error('Collector Job was replaced');
  record = await updateRecord(repo, input, record, { jobUid: job.metadata.uid!, creationDeadline: 0 });
  if (job.status?.failed || job.status?.conditions?.some(condition => condition.type === 'Failed' && condition.status === 'True')) {
    await cleanupCollector(input, record, input.signal);
    throw new Error('Trusted artifact inventory failed; output must be readable by UID 1000 and contain only stable regular files');
  }
  if (!job.status?.succeeded) return undefined;
  const pods = await all<Pod>(podPath(record.namespace), `job-name=${record.name}`, input.signal);
  const pod = successfulInventoryPod(pods, job);
  assertInventoryJob({ metadata: job.metadata, spec: { template: { spec: pod.spec } } }, input, record.image);
  const response = await k8sRequest(`${podPath(record.namespace, pod.metadata.name)}/log?container=inventory&timestamps=false&limitBytes=${INVENTORY_LIMIT + 1}`,
    { signal: k8sSignal(input.signal) });
  const text = await boundedText(response.body);
  const inventory = parseInventory(text, record.identity);
  await assertCurrent(repo, input);
  const inventoryKey = `${prefix}.pai/inventory.ndjson`;
  let inventoryVersion: string | undefined;
  try {
    const saved = await s3().send(new PutObjectCommand({
      Bucket: bucket, Key: inventoryKey, Body: text, ContentType: 'application/x-ndjson', IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256', ChecksumSHA256: createHash('sha256').update(text).digest('base64'),
    }), { abortSignal: input.signal });
    inventoryVersion = saved.VersionId;
  } catch (error) {
    if ((error as Error).name !== 'PreconditionFailed') throw error;
    const existing = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: inventoryKey }), { abortSignal: input.signal });
    if (sha256(await boundedText(existing.Body)) !== sha256(text)) throw new Error('Another inventory already owns this publication');
    inventoryVersion = existing.VersionId;
  }
  if (!inventoryVersion || inventoryVersion === 'null') throw new Error('Inventory archive must have S3 versioning enabled');
  record = await updateRecord(repo, input, record, { inventoryKey, inventoryVersion, inventorySHA256: sha256(text) });
  return await cleanupCollector(input, record, input.signal) ? inventory : undefined;
}

/** Read only. AutoExport associations must never receive manual export tasks. */
async function repositoryFor(fileSystemId: string, sourcePath: string, signal: AbortSignal) {
  const associations: DataRepositoryAssociation[] = []; const seen = new Set<string>(); let token: string | undefined;
  do {
    const page = await fsx().send(new DescribeDataRepositoryAssociationsCommand({
      Filters: [{ Name: 'file-system-id', Values: [fileSystemId] }], NextToken: token,
    }), { abortSignal: signal });
    associations.push(...page.Associations ?? []); token = page.NextToken;
    if (token && seen.has(token)) throw new Error('Repeated DRA pagination token');
    if (token) seen.add(token);
  } while (token);
  const path = sourcePath.slice('/fsx'.length);
  const covering = associations.filter(association => {
    const root = association.FileSystemPath?.replace(/\/$/, '') ?? '';
    return association.FileSystemId === fileSystemId && association.DataRepositoryPath?.startsWith('s3://') &&
      !!association.FileSystemPath && (path === root || path.startsWith(root + '/'));
  }).sort((a, b) => b.FileSystemPath!.length - a.FileSystemPath!.length);
  const association = covering[0];
  if (!association || !['AVAILABLE', 'UPDATING'].includes(association.Lifecycle ?? '')) throw new Error('No available DRA covers this output path');
  const match = /^s3:\/\/([^/]+)\/(.*)$/.exec(association.DataRepositoryPath!);
  if (!match) throw new Error('Invalid DRA repository path');
  const root = association.FileSystemPath!.replace(/\/$/, '');
  const prefix = (match[2] ? match[2].replace(/\/?$/, '/') : '') + path.slice(root.length).replace(/^\//, '');
  return { bucket: match[1], prefix, associationId: association.AssociationId,
    automatic: !!association.S3?.AutoExportPolicy?.Events?.length };
}

export const artifactPublisher: Publisher = {
  async publish(input) {
    if (currentBackend()?.id !== backendId(input.workflow.backendId)) return runOnBackend(input.workflow, () => artifactPublisher.publish(input));
    assertBackendReady();
    const c = config(); const bucket = process.env.DASHBOARD_ARTIFACT_BUCKET;
    if (!bucket || !c.eks?.fsxFileSystemId) throw new Error('Durable artifact storage/FSx is not configured');
    await assertCurrent(getRepo(), input);
    const source = await repositoryFor(c.eks.fsxFileSystemId, input.sourcePath, input.signal);
    if (currentBackend()?.profile && source.bucket !== c.eks.dataBucket) throw new Error('FSx DRA bucket does not match the registered backend data bucket');
    const prefix = publicationPrefix(input);
    const inventory = await collectInventory(input, bucket, prefix);
    if (!inventory) return pending('Waiting for trusted output inventory and collector cleanup');
    await assertCurrent(getRepo(), input);
    if (!source.automatic) {
      const repo = getRepo(); const key = { pk: `PUBLICATION#${input.publicationId}`, sk: 'EXPORT' };
      let record = await repo.kv.get(key.pk, key.sk);
      if (!record?.taskId) {
        const result = await fsx().send(new CreateDataRepositoryTaskCommand({
          FileSystemId: c.eks.fsxFileSystemId, Type: 'EXPORT_TO_REPOSITORY',
          Paths: [input.sourcePath.slice('/fsx/'.length)], ClientRequestToken: sha256(input.publicationId).slice(0, 32),
          Report: { Enabled: false },
        }), { abortSignal: input.signal });
        if (!result.DataRepositoryTask?.TaskId) throw new Error('FSx export did not return a task ID');
        record = { ...key, taskId: result.DataRepositoryTask.TaskId };
        if (!await repo.kv.transaction([...currentChecks(input), { kind: 'put', item: record }])) throw new Error('Manual export intent was fenced');
        return pending('FSx 결과를 S3로 내보내는 중입니다.');
      }
      const exported = await fsx().send(new DescribeDataRepositoryTasksCommand({ TaskIds: [String(record.taskId)] }), { abortSignal: input.signal });
      const task = exported.DataRepositoryTasks?.find(task => task.TaskId === record!.taskId);
      if (!task) throw new Error('Artifact export task was not found');
      if (['FAILED', 'CANCELED'].includes(task.Lifecycle ?? '')) throw new Error(`Artifact export ${task.Lifecycle}`);
      if (task.Lifecycle !== 'SUCCEEDED') return pending('FSx 내보내기 완료를 기다리는 중입니다.');
      if ((task.Status?.FailedCount ?? 0) > 0) throw new Error('Some output files failed to export');
    }
    try {
      const snapshot = await snapshotPrefix({
        sourceBucket: source.bucket, sourcePrefix: source.prefix, targetBucket: bucket, targetPrefix: prefix,
        identity: inventoryIdentity(input), inventory, signal: input.signal, assertCurrent: () => assertCurrent(getRepo(), input),
      });
      await assertCurrent(getRepo(), input);
      return ready(bucket, prefix, snapshot.manifest, snapshot.hash);
    } catch (error) {
      if (error instanceof SnapshotPendingError) return pending(error.message);
      throw error;
    }
  },
};

/** Parent must await this for cancellation/failure/retry, never for successful
 * workload cleanup on the way to FINALIZING. True means no collectors/Pods remain
 * and no still-in-flight creation intent can appear afterwards. */
export async function cancelArtifactCollectors(workflow: Workflow, context: {
  signal: AbortSignal; taskNames?: string[]; attempt?: number;
}): Promise<boolean> {
  if (currentBackend()?.id !== backendId(workflow.backendId)) return runOnBackend(workflow, () => cancelArtifactCollectors(workflow, context), getRepo(), () => new Date(), 'observe');
  context.signal.throwIfAborted();
  const repo = getRepo();
  const tasks = await repo.listTasks(workflow.id);
  const selected = tasks.filter(task => !context.taskNames || context.taskNames.includes(task.name));
  for (const task of selected) {
    const attempt = context.attempt ?? task.attempts;
    await repo.kv.put({ ...inventoryFence(workflow.id, task.name, attempt), projectId: workflow.projectId, at: new Date().toISOString() }, 'not_exists');
  }
  const records = (await repo.kv.query(`WF#${workflow.id}`, 'ARTIFACT#')) as CollectorRecord[];
  let gone = true;
  for (const record of records) {
    if (context.taskNames && !context.taskNames.includes(record.taskName) || context.attempt !== undefined && record.attempt !== context.attempt) continue;
    const task = tasks.find(task => task.name === record.taskName);
    if (!task) throw new Error('Collector has no declared source task');
    await repo.kv.put({ ...inventoryFence(workflow.id, record.taskName, record.attempt), projectId: workflow.projectId }, 'not_exists');
    const input: InventoryScope = { workflow, task: { ...task, attempts: record.attempt, attemptEpoch: record.epoch,
      outputPath: `/fsx/checkpoints/projects/${workflow.projectId}/runs/${workflow.id}/attempts/${record.attempt}/${task.name}` },
      publicationId: record.publicationId, sourcePath: record.sourcePath, attempt: record.attempt };
    if (!await cleanupCollector(input, record, context.signal)) gone = false;
  }
  return gone;
}
