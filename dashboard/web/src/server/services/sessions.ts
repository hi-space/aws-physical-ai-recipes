import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { backendConfig as config } from '../backends/context';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import * as hp from '../aws/hyperpod';
import { assertWritableNamespace, K8sError, k8sGetOrNull, k8sJson } from '../k8s/client';
import { createJob, getJob, getPod, listPods, managedLabels, type Job, type Pod, type Meta } from '../k8s/resources';
import { getRepo, type Repo } from '../store/repo';
import type { Session, Workflow } from '../store/types';
import type { Session as Principal } from '../auth/session';
import { resolveProject, type Project } from '../auth/projects';
import { issueLaunchTicket } from '../gateway/auth';
import type { GatewaySession, AuthOptions } from '../gateway/types';
import { assertTokenLaunchPrincipal, assertTokenRequestProject, authorizeDerivedToken, hasTokenBinding, tokenBindingForPrincipal } from '../gateway/token-grants';
import { currentBackend, runOnBackend, assertBackendReady } from '../backends/context';
import { backendId } from '../backends/registry';
import { assertWorkflowBackend } from '../backends/binding';

const LABEL = 'pai.aws/session';
const MANAGED = 'pai.aws/managed-session';
const PORTS = { tensorboard: 6006, jupyter: 8888, 'code-server': 8080 } as const;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ttl = z.number().int().min(5).max(1440).default(60);
export const createSessionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tensorboard'), logDir: z.string().min(1).max(1024), ttlMinutes: ttl }).strict(),
  z.object({ kind: z.literal('jupyter'), ttlMinutes: ttl }).strict(),
  z.object({ kind: z.literal('code-server'), ttlMinutes: ttl }).strict(),
  z.object({ kind: z.literal('terminal'), workflowId: z.string().regex(dns), taskName: z.string().regex(dns), replicaIndex: z.number().int().min(0).max(63).default(0), ttlMinutes: ttl }).strict(),
  z.object({ kind: z.literal('port-forward'), workflowId: z.string().regex(dns), taskName: z.string().regex(dns), replicaIndex: z.number().int().min(0).max(63).default(0), portName: z.string().regex(dns), ttlMinutes: ttl }).strict(),
]);
export type CreateSessionInput = z.input<typeof createSessionSchema>;
export const extendSessionSchema = z.object({ ttlMinutes: z.number().int().min(5).max(1440) }).strict();
interface OwnerReference { kind: string; name: string; uid: string; controller?: boolean }
type SessionPod = Omit<Pod, 'metadata' | 'spec'> & { metadata: Meta & { ownerReferences?: OwnerReference[] }; spec: Omit<Pod['spec'], 'containers'> & {
  hostNetwork?: boolean;
  containers: Array<Pod['spec']['containers'][number] & { ports?: Array<{ name?: string; containerPort: number; protocol?: string }> }>;
} };
interface LegacyObject { metadata: Meta }
type Deletable = 'jobs' | 'pods' | 'deployments' | 'replicasets' | 'services';
export interface SessionDeps {
  repo: Repo;
  now: () => number;
  image?: string;
  runtimeImage?: string;
  currentUser?: AuthOptions['currentUser'];
  k8s: {
    prepare(project: Project): Promise<void>;
    getJob(ns: string, name: string): Promise<Job | null>;
    createJob(ns: string, manifest: unknown): Promise<Job>;
    listPods(ns: string, selector: string): Promise<SessionPod[]>;
    getPod(ns: string, name: string): Promise<SessionPod | null>;
    deleteObject(ns: string, kind: Deletable, name: string, uid?: string): Promise<void>;
    listLegacy(ns: string, kind: 'deployments' | 'replicasets' | 'services', selector: string): Promise<LegacyObject[]>;
  };
}
function resourcePath(ns: string, kind: Deletable): string {
  assertWritableNamespace(ns);
  return `${kind === 'jobs' ? '/apis/batch/v1' : ['deployments', 'replicasets'].includes(kind) ? '/apis/apps/v1' : '/api/v1'}/namespaces/${ns}/${kind}`;
}
function defaults(): SessionDeps {
  return { repo: getRepo(), now: Date.now, image: process.env.WORKSPACE_IMAGE_URI, runtimeImage: process.env.TASK_RUNTIME_IMAGE, k8s: {
    prepare: prepareNamespace, getJob, createJob,
    listPods: (ns, selector) => listPods(ns, selector) as Promise<SessionPod[]>, getPod: (ns, name) => getPod(ns, name) as Promise<SessionPod | null>,
    deleteObject: async (ns, kind, name, uid) => {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw badRequest('Invalid managed resource name');
      try { await k8sJson(`${resourcePath(ns, kind)}/${name}`, { method: 'DELETE', body: { propagationPolicy: 'Foreground', ...(uid ? { preconditions: { uid } } : {}) } }); }
      catch (error) { if (!(error instanceof K8sError && error.status === 404)) throw error; }
    },
    listLegacy: async (ns, kind, selector) => {
      const result: LegacyObject[] = []; let continuation: string | undefined;
      do {
        const query = new URLSearchParams({ labelSelector: selector, limit: '500', ...(continuation ? { continue: continuation } : {}) });
        const page = await k8sJson<{ items: LegacyObject[]; metadata?: { continue?: string } }>(`${resourcePath(ns, kind)}?${query}`);
        result.push(...page.items); continuation = page.metadata?.continue;
      } while (continuation);
      return result;
    },
  } };
}

/** These are existing project resources; no namespace/PVC/queue is provisioned by a session. */
async function prepareNamespace(project: Project) {
  assertWritableNamespace(project.namespace);
  const sa = process.env.WORKSPACE_SERVICE_ACCOUNT ?? 'pai-workload';
  if (!dns.test(sa)) throw new HttpError(503, 'Invalid workspace service account');
  const [namespace, pvc, queue, identity] = await Promise.all([
    k8sGetOrNull(`/api/v1/namespaces/${project.namespace}`),
    k8sGetOrNull(`/api/v1/namespaces/${project.namespace}/persistentvolumeclaims/fsx-pvc`),
    k8sGetOrNull(`/apis/kueue.x-k8s.io/v1beta1/namespaces/${project.namespace}/localqueues/${project.queue}`),
    k8sGetOrNull<{ metadata?: Meta }>(`/api/v1/namespaces/${project.namespace}/serviceaccounts/${sa}`),
  ]);
  if (!namespace || !pvc || !queue || !identity) throw new HttpError(503, 'Project namespace, FSx claim, queue and workload service account must be provisioned');
  if (identity.metadata?.annotations?.['eks.amazonaws.com/role-arn']) throw new HttpError(503, 'Workspace service account must not carry an AWS role');
  const path = `/apis/networking.k8s.io/v1/namespaces/${project.namespace}/networkpolicies/pai-sessions`;
  const existing = await k8sGetOrNull<{ metadata?: Meta }>(path);
  if (existing && existing.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'physical-ai-dashboard') throw new HttpError(409, 'Session network policy name is already owned');
  await k8sJson(`${path}?fieldManager=pai-sessions`, { method: 'PATCH', headers: { 'content-type': 'application/apply-patch+yaml' }, body: {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'pai-sessions', namespace: project.namespace, labels: managedLabels() },
    spec: { podSelector: { matchLabels: { [MANAGED]: 'true' } }, policyTypes: ['Ingress', 'Egress'], ingress: [],
      egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.0.0/16'] } }, { ipBlock: { cidr: '::/0', except: ['fe80::/10', 'fd00:ec2::/32'] } }] }] },
  } });
}
function subject(p: Principal) { if (!p.subject) throw forbidden('A verified Cognito subject is required'); return p.subject; }
const ownerHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
function labels(s: Session) { return managedLabels({ [LABEL]: s.id, [MANAGED]: 'true', 'pai.aws/project': s.projectId!, 'pai.aws/owner-subject': ownerHash(s.ownerSubject!), ...(s.backendId ? { 'pai.aws/backend': s.backendId } : {}) }); }
function isOwner(s: Session, p: Principal) { return s.ownerSubject ? s.ownerSubject === p.subject : s.owner === p.user; }
export function assertSessionOwner(s: Session, p: Principal, allowAdmin = false) {
  if (!(isOwner(s, p) || allowAdmin && p.role === 'admin')) throw forbidden('Only the session owner may perform this action');
}
async function projectFor(s: Session, p: Principal, deps: SessionDeps) {
  if (!s.projectId) throw new HttpError(409, 'Legacy sessions can only be ended');
  assertTokenRequestProject(p, s.projectId);
  const project = await resolveProject(p, s.projectId, deps.repo, 'researcher');
  if (project.namespace !== s.namespace || backendId(project.backendId) !== backendId(s.backendId) || project.backendConfigHash !== s.backendConfigHash || !['researcher', 'project-admin'].includes(project.members[subject(p)])) throw forbidden('Current project researcher membership and backend binding are required');
  return project;
}
function logPath(path: string, projectId: string) {
  if (!path.startsWith('/fsx/') || path.includes('\\')) throw badRequest('Log directory must be a scoped project FSx path');
  const parts = path.slice(5).split('/');
  if (parts.length < 4 || !['checkpoints', 'datasets'].includes(parts[0]) || parts[1] !== 'projects' || parts[2] !== projectId ||
    parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) throw badRequest('Log directory must be a narrow path inside this project');
  return parts.join('/');
}
function trustedImage(image?: string, variable = 'WORKSPACE_IMAGE_URI') {
  if (!image || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]+$/.test(image) || image.endsWith(':latest')) throw new HttpError(503, `${variable} must reference its trusted built image`);
  return image;
}
export function sessionJob(s: Session) {
  if (!(s.kind in PORTS) || !s.projectId || !s.queue) throw badRequest('Managed app identity is incomplete');
  const image = trustedImage(s.image), runtimeImage = trustedImage(s.runtimeImage, 'TASK_RUNTIME_IMAGE'), port = PORTS[s.kind as keyof typeof PORTS];
  const appSecurity = { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  const logs = s.kind === 'tensorboard' ? logPath(s.logDir!, s.projectId) : undefined;
  const ownership = labels(s), queuedLabels = { ...ownership, 'kueue.x-k8s.io/queue-name': s.queue };
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: s.name, namespace: s.namespace, labels: queuedLabels }, spec: {
    suspend: true, parallelism: 1, completions: 1, backoffLimit: 0, ttlSecondsAfterFinished: 86400,
    // Absolute session expiration is enforced by the worker/gateway; this is a hard runtime fallback.
    activeDeadlineSeconds: 86400,
    template: { metadata: { labels: queuedLabels }, spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false, serviceAccountName: process.env.WORKSPACE_SERVICE_ACCOUNT ?? 'pai-workload',
      hostNetwork: false, hostPID: false, hostIPC: false, enableServiceLinks: false, terminationGracePeriodSeconds: 15,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [{ name: 'fsx', persistentVolumeClaim: { claimName: 'fsx-pvc' } }, { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } }],
      initContainers: [{ name: 'prepare-workspace', image,
        command: ['python', '/opt/pai/prepare.py', s.projectId, s.id, ...(logs ? [logs] : [])],
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
        securityContext: { ...appSecurity, runAsUser: 0, runAsGroup: 0, runAsNonRoot: false, capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] } },
        volumeMounts: [{ name: 'fsx', mountPath: '/pai-fsx' }],
      }, {
        name: 'verify-workspace-isolation', image: runtimeImage,
        command: ['/opt/pai/runtime', '--verify-isolation'],
        resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
        securityContext: appSecurity,
      }],
      containers: [{ name: 'workspace', image, args: [s.kind], workingDir: '/workspace', securityContext: appSecurity,
        ports: [{ name: 'app', containerPort: port }],
        env: [{ name: 'HOME', value: '/workspace' }, { name: 'AWS_EC2_METADATA_DISABLED', value: 'true' }],
        resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
        volumeMounts: [{ name: 'fsx', mountPath: '/workspace', subPath: `sessions/projects/${s.projectId}/${s.id}` }, { name: 'tmp', mountPath: '/tmp' }, ...(logs ? [{ name: 'fsx', mountPath: '/logs', subPath: logs, readOnly: true }] : [])],
        readinessProbe: { exec: { command: ['python', '/opt/pai/session.py', '--ready', s.kind] }, initialDelaySeconds: 3, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
      }],
    } },
  } };
}

/** CAS prevents a concurrent readiness refresh/extension from resurrecting a revoked session. */
async function save(s: Session, changes: Partial<Session>, deps: SessionDeps): Promise<Session> {
  const next = { ...s, ...changes, revision: (s.revision ?? 0) + 1 };
  const equals: Record<string, unknown> = s.revision === undefined ? { createdAt: s.createdAt, name: s.name, owner: s.owner, ...(s.status ? { status: s.status } : {}) } : { revision: s.revision };
  if (!(await deps.repo.kv.transaction([{ kind: 'put', item: { pk: `SESS#${s.id}`, sk: 'META', gsi1pk: 'TYPE#SESS', gsi1sk: `${s.createdAt}#${s.id}`, ...next }, condition: { equals } }]))) {
    throw new HttpError(409, 'Session changed; refresh and retry');
  }
  return next;
}
async function read(id: string, deps: SessionDeps) {
  if (!dns.test(id)) throw badRequest('Invalid session id');
  const s = await deps.repo.getSession(id); if (!s) throw notFound('session'); return s;
}
async function createdJob(s: Session, job: Job, deps: SessionDeps): Promise<Session> {
  // A close may have won while the Kubernetes create was in flight. Never overwrite
  // its revocation; attach the actual UID and clean this late result instead.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await read(s.id, deps);
    assertJob(current, job);
    try {
      const changed = await save(current, { jobUid: job.metadata.uid, provisioningUntil: undefined,
        ...(current.revokedAt || ['CLOSING', 'CLOSED'].includes(current.status ?? '') ? { status: 'CLOSING', closedAt: undefined } : {}) }, deps);
      return changed.revokedAt || changed.status === 'CLOSING' ? close(changed, deps) : changed;
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409 && error.message === 'Session changed; refresh and retry')) throw error;
    }
  }
  throw new HttpError(409, 'Session changed during Job creation; reconciliation will retry');
}
function assertJob(s: Session, job: Job) {
  if (job.metadata.labels?.[LABEL] !== s.id || job.metadata.labels?.['pai.aws/project'] !== s.projectId ||
    job.metadata.labels?.['pai.aws/owner-subject'] !== ownerHash(s.ownerSubject!) || !job.metadata.uid || s.jobUid && job.metadata.uid !== s.jobUid) throw new HttpError(409, 'Managed Job ownership changed');
}
function readyPod(p: SessionPod, container: string) {
  const variables = p.spec.containers.flatMap((c) => c.env ?? []);
  if (p.spec.hostNetwork || variables.some((v) => /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_.*|CONTAINER_AUTHORIZATION_.*)$/.test(v.name))) return false;
  return !!p.metadata.uid && !p.metadata.deletionTimestamp && p.status?.phase === 'Running' && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') && p.status.containerStatuses?.some((c) => c.name === container && c.ready);
}
function ownedPod(s: Session, p: SessionPod) {
  return p.metadata.labels?.[LABEL] === s.id && p.metadata.ownerReferences?.some((r) => r.kind === 'Job' && r.name === s.name && (!s.jobUid || r.uid === s.jobUid));
}
async function taskTarget(workflowId: string, taskName: string, replicaIndex: number, principal: Principal, project: Project, deps: SessionDeps) {
  const wf = await deps.repo.getWorkflow(workflowId);
  if (!wf || wf.ownerSubject !== subject(principal) || wf.projectId !== project.id || wf.namespace !== project.namespace || backendId(wf.backendId) !== backendId(project.backendId) || wf.backendConfigHash !== project.backendConfigHash) throw forbidden('Only your own project workflow on its bound backend can be attached');
  if (wf.status !== 'RUNNING' || await deps.repo.cancellation(wf.id)) throw new HttpError(409, 'Workflow is not running');
  const task = (await deps.repo.listTasks(wf.id)).find((t) => t.name === taskName);
  if (!task || task.phase !== 'RUNNING' || !task.attemptEpoch) throw new HttpError(409, 'Task has no live running attempt');
  const selector = `pai.aws/workflow-id=${wf.id},pai.aws/task=${task.name},pai.aws/attempt=${task.attempts},pai.aws/epoch=${task.attemptEpoch}`;
  const candidates = (await deps.k8s.listPods(project.namespace, selector)).filter((p) =>
    p.metadata.labels?.['app.kubernetes.io/managed-by'] === 'physical-ai-dashboard' &&
    p.metadata.labels?.['pai.aws/workflow-id'] === wf.id && p.metadata.labels?.['pai.aws/task'] === task.name &&
    p.metadata.labels?.['pai.aws/attempt'] === String(task.attempts) && p.metadata.labels?.['pai.aws/epoch'] === task.attemptEpoch &&
    Number(p.metadata.labels?.['batch.kubernetes.io/job-completion-index'] ?? 0) === replicaIndex && readyPod(p, 'main'));
  if (candidates.length !== 1) throw new HttpError(409, 'Selected task replica is not uniquely ready');
  return { wf, task, pod: candidates[0] };
}
function namedPort(pod: SessionPod, name: string) {
  const ports = pod.spec.containers.find((c) => c.name === 'main')?.ports?.filter((p) => p.name === name && (!p.protocol || p.protocol === 'TCP')) ?? [];
  if (ports.length !== 1 || !Number.isInteger(ports[0].containerPort) || ports[0].containerPort < 1 || ports[0].containerPort > 65535) throw badRequest('Named task TCP port is not registered on the selected container');
  return ports[0].containerPort;
}

export async function createManagedSession(raw: CreateSessionInput, principal: Principal, suppliedProject: Project, deps = defaults()): Promise<Session> {
  const parsed = createSessionSchema.safeParse(raw); if (!parsed.success) throw badRequest('Invalid session request', parsed.error.issues);
  const input = parsed.data, ownerSubject = subject(principal);
  assertTokenRequestProject(principal, suppliedProject.id);
  const project = await resolveProject(principal, suppliedProject.id, deps.repo, 'researcher');
  if (currentBackend()?.id !== backendId(project.backendId)) return runOnBackend(project, () => createManagedSession(raw, principal, project, deps), deps.repo);
  assertBackendReady();
  if (!['researcher', 'project-admin'].includes(project.members[ownerSubject]) || !/^hyperpod-ns-/.test(project.namespace) || !dns.test(project.queue)) throw forbidden('A governed project and researcher membership are required');
  assertWritableNamespace(project.namespace);
  const source = await tokenBindingForPrincipal(principal, project.id, { repo: deps.repo, now: deps.now, currentUser: deps.currentUser });
  const id = randomBytes(10).toString('hex'), now = deps.now();
  const expires = Math.min(now + input.ttlMinutes * 60_000, source ? Date.parse(source.tokenExpiresAt) : Infinity);
  let s: Session = { id, name: `session-${id}`, kind: input.kind, projectId: project.id, backendId: backendId(project.backendId), backendConfigHash: project.backendConfigHash, ownerSubject, owner: principal.user,
    namespace: project.namespace, queue: project.queue, createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), revision: 0, ...source };
  if (input.kind === 'terminal' || input.kind === 'port-forward') {
    const { task, pod } = await taskTarget(input.workflowId, input.taskName, input.replicaIndex, principal, project, deps);
    s = { ...s, status: 'READY', managedJob: false, workflowId: input.workflowId, taskName: task.name, groupId: task.groupId,
      attempt: task.attempts, attemptEpoch: task.attemptEpoch, replicaIndex: input.replicaIndex,
      podName: pod.metadata.name, podUid: pod.metadata.uid, nodeName: pod.spec.nodeName, container: 'main',
      ...(input.kind === 'port-forward' ? { portName: input.portName, port: namedPort(pod, input.portName) } : {}) };
  } else {
    if (input.kind === 'tensorboard') logPath(input.logDir, project.id);
    s = { ...s, status: 'QUEUED', managedJob: true, provisioningUntil: new Date(now + 120_000).toISOString(), image: trustedImage(deps.image), runtimeImage: trustedImage(deps.runtimeImage, 'TASK_RUNTIME_IMAGE'), container: 'workspace', port: PORTS[input.kind],
      workspacePath: `/fsx/sessions/projects/${project.id}/${id}`, ...(input.kind === 'tensorboard' ? { logDir: input.logDir } : {}) };
    await deps.k8s.prepare(project);
  }
  await authorizeDerivedToken(s, { repo: deps.repo, now: deps.now, currentUser: deps.currentUser });
  // Durable intent precedes the external Job create; reconciliation can adopt its unique labelled name.
  const inserted = await deps.repo.kv.put({ pk: `SESS#${id}`, sk: 'META', gsi1pk: 'TYPE#SESS', gsi1sk: `${s.createdAt}#${id}`, ...s }, 'not_exists');
  if (!inserted) throw new HttpError(409, 'Session id collision');
  if (s.managedJob) {
    const job = await deps.k8s.createJob(s.namespace, sessionJob(s)); assertJob(s, job);
    s = await createdJob(s, job, deps);
  }
  return s;
}

async function refresh(s: Session, deps: SessionDeps): Promise<Session> {
  if (s.kind === 'dcv') return s;
  await assertWorkflowBackend(s, deps.repo);
  if (currentBackend()?.id !== backendId(s.backendId)) return runOnBackend(s, () => refresh(s, deps), deps.repo, () => new Date(deps.now()), 'observe');
  if (s.status === 'CLOSED') return s.managedJob ? close(s, deps) : s;
  if (s.revokedAt || s.status === 'CLOSING' || s.expiresAt && Date.parse(s.expiresAt) <= deps.now()) return close(s, deps);
  assertBackendReady();
  if (!s.ownerSubject || !s.expiresAt || s.managedJob === undefined) return s;
  try { await authorizeDerivedToken(s, { repo: deps.repo, now: deps.now, currentUser: deps.currentUser }); }
  catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.status)) return close(s, deps);
    throw error;
  }
  if (s.managedJob) {
    let job = await deps.k8s.getJob(s.namespace, s.name);
    if (!job && !s.jobUid) {
      if (s.provisioningUntil && Date.parse(s.provisioningUntil) > deps.now()) return s;
      s = await save(s, { provisioningUntil: new Date(deps.now() + 120_000).toISOString() }, deps);
      // Recover a persisted create intent after API/process failure. A concurrent closer
      // can fence this row; a raced late Job is discovered by its stable session label.
      const current = await read(s.id, deps); if (current.revokedAt || current.status === 'CLOSING') return close(current, deps);
      const principal: Principal = { subject: s.ownerSubject, user: s.owner, email: '', role: 'researcher' };
      const project = await projectFor(s, principal, deps); await deps.k8s.prepare(project);
      try { job = await deps.k8s.createJob(s.namespace, sessionJob(s)); }
      catch (e) { if (!(e instanceof K8sError && e.status === 409)) throw e; job = await deps.k8s.getJob(s.namespace, s.name); }
      if (job) {
        const recorded = await createdJob(s, job, deps);
        if (recorded.revokedAt || ['CLOSING', 'CLOSED'].includes(recorded.status ?? '')) return recorded;
        s = recorded;
      }
    }
    if (!job) return close(s, deps);
    assertJob(s, job);
    const withUid = { ...s, jobUid: job.metadata.uid };
    const candidates = (await deps.k8s.listPods(s.namespace, `${LABEL}=${s.id}`)).filter((p) => ownedPod(withUid, p));
    const pod = candidates.length === 1 && readyPod(candidates[0], 'workspace') ? candidates[0] : undefined;
    const completed = job.status?.conditions?.some((c) => ['Failed', 'Complete'].includes(c.type) && c.status === 'True');
    if (completed) return close(withUid, deps);
    const status = pod ? 'READY' : job.spec.suspend ? 'QUEUED' : 'STARTING';
    const changes = { status, jobUid: job.metadata.uid, provisioningUntil: undefined, podName: pod?.metadata.name, podUid: pod?.metadata.uid, nodeName: pod?.spec.nodeName,
      message: status === 'QUEUED' ? 'Waiting for project queue admission' : status === 'STARTING' ? 'Preparing workspace and waiting for the app readiness probe' : undefined };
    if (Object.entries(changes).every(([key, value]) => s[key as keyof Session] === value)) return s;
    return save(s, changes, deps);
  }
  try {
    const principal: Principal = { subject: s.ownerSubject, user: s.owner, email: '', role: 'researcher' };
    const project = await projectFor(s, principal, deps);
    const { task, pod } = await taskTarget(s.workflowId!, s.taskName!, s.replicaIndex ?? 0, principal, project, deps);
    if (task.attempts !== s.attempt || task.attemptEpoch !== s.attemptEpoch || pod.metadata.uid !== s.podUid || pod.metadata.name !== s.podName) return close(s, deps);
    if (s.kind === 'port-forward' && namedPort(pod, s.portName!) !== s.port) return close(s, deps);
    return s;
  } catch (error) {
    if (error instanceof HttpError && [400, 403, 404, 409].includes(error.status)) return close(s, deps);
    throw error;
  }
}

async function close(initial: Session, deps: SessionDeps): Promise<Session> {
  await assertWorkflowBackend(initial, deps.repo);
  if (currentBackend()?.id !== backendId(initial.backendId)) return runOnBackend(initial, () => close(initial, deps), deps.repo, () => new Date(deps.now()), 'observe');
  let s = initial;
  if (s.kind === 'dcv') throw new HttpError(501, 'DCV lifecycle is handled by its managed adapter');
  if (s.status === 'CLOSED') {
    if (!s.managedJob) return s;
    const [job, pods] = await Promise.all([deps.k8s.getJob(s.namespace, s.name), deps.k8s.listPods(s.namespace, `${LABEL}=${s.id}`)]);
    if (!job && !pods.length) return s;
    s = await save(s, { status: 'CLOSING', closedAt: undefined }, deps);
  }
  if (!s.revokedAt || s.status !== 'CLOSING') s = await save(s, { status: 'CLOSING', revokedAt: new Date(deps.now()).toISOString(), message: 'Waiting for managed resources to terminate' }, deps);
  if (s.managedJob) {
    const job = await deps.k8s.getJob(s.namespace, s.name);
    if (!job && !s.jobUid && s.provisioningUntil && Date.parse(s.provisioningUntil) > deps.now()) return s;
    if (job) { assertJob(s, job); if (!s.jobUid) s = await save(s, { jobUid: job.metadata.uid }, deps); await deps.k8s.deleteObject(s.namespace, 'jobs', s.name, job.metadata.uid); }
    const pods = await deps.k8s.listPods(s.namespace, `${LABEL}=${s.id}`);
    for (const pod of pods) {
      if (!ownedPod(s, pod) || !pod.metadata.uid) throw new HttpError(409, 'Session pod ownership is not confirmed');
      await deps.k8s.deleteObject(s.namespace, 'pods', pod.metadata.name, pod.metadata.uid);
    }
    const [remainingJob, remainingPods] = await Promise.all([deps.k8s.getJob(s.namespace, s.name), deps.k8s.listPods(s.namespace, `${LABEL}=${s.id}`)]);
    if (remainingJob || remainingPods.length) return s;
  } else if (s.managedJob === undefined) {
    const selector = `${LABEL}=${s.id}`;
    for (const kind of ['deployments', 'replicasets', 'services'] as const) {
      for (const object of await deps.k8s.listLegacy(s.namespace, kind, selector)) {
        if (object.metadata.labels?.[LABEL] !== s.id || !object.metadata.uid) throw new HttpError(409, 'Legacy resource ownership is not confirmed');
        await deps.k8s.deleteObject(s.namespace, kind, object.metadata.name, object.metadata.uid);
      }
    }
    for (const pod of await deps.k8s.listPods(s.namespace, selector)) {
      if (pod.metadata.labels?.[LABEL] !== s.id || !pod.metadata.uid) throw new HttpError(409, 'Legacy pod ownership is not confirmed');
      await deps.k8s.deleteObject(s.namespace, 'pods', pod.metadata.name, pod.metadata.uid);
    }
    const leftovers = await Promise.all(['deployments', 'replicasets', 'services'].map((kind) => deps.k8s.listLegacy(s.namespace, kind as 'deployments', selector)));
    if (leftovers.some((list) => list.length) || (await deps.k8s.listPods(s.namespace, selector)).length) return s;
  }
  // Attached sessions own gateway access only. The workflow controller owns training resources.
  return save(s, { status: 'CLOSED', closedAt: new Date(deps.now()).toISOString(), message: undefined }, deps);
}
export async function deleteSession(id: string, principal?: Principal, deps = defaults()) {
  const s = await read(id, deps);
  if (principal) { assertSessionOwner(s, principal, true); assertTokenRequestProject(principal, s.projectId); }
  const result = await close(s, deps);
  if (result.managedJob === undefined && result.status === 'CLOSED') {
    const equals = result.revision === undefined ? { createdAt: result.createdAt, status: 'CLOSED' } : { revision: result.revision };
    if (!(await deps.repo.kv.transaction([{ kind: 'delete', pk: `SESS#${id}`, sk: 'META', condition: { equals } }]))) throw new HttpError(409, 'Legacy session changed during removal');
  }
  return result;
}
export async function launchSession(id: string, principal: Principal, deps = defaults()): Promise<{ url: string; expiresAt: string }> {
  let s = await read(id, deps); assertSessionOwner(s, principal); subject(principal);
  if (currentBackend()?.id !== backendId(s.backendId)) return runOnBackend(s, () => launchSession(id, principal, deps), deps.repo);
  assertTokenLaunchPrincipal(s, principal);
  await projectFor(s, principal, deps);
  if (!s.ownerSubject || !s.expiresAt || !s.projectId || s.managedJob === undefined) throw new HttpError(409, 'Legacy sessions cannot be launched');
  s = await refresh(s, deps);
  if (s.status !== 'READY' || s.revokedAt || !s.podName || !s.podUid || !s.container) throw new HttpError(409, 'Session is not ready');
  const pod = await deps.k8s.getPod(s.namespace, s.podName);
  if (!pod || pod.metadata.uid !== s.podUid || !readyPod(pod, s.container) || s.managedJob && !ownedPod(s, pod)) throw new HttpError(409, 'Registered session pod is no longer ready');
  const launch = await issueLaunchTicket(s as GatewaySession, principal, { repo: deps.repo, now: deps.now, currentUser: deps.currentUser });
  return { url: launch.url, expiresAt: launch.expiresAt };
}
export async function extendSession(id: string, ttlMinutes: number, principal: Principal, deps = defaults()) {
  const parsed = extendSessionSchema.safeParse({ ttlMinutes }); if (!parsed.success) throw badRequest('Invalid session extension');
  const s = await read(id, deps); assertSessionOwner(s, principal); assertTokenLaunchPrincipal(s, principal); await projectFor(s, principal, deps);
  if (!s.expiresAt || s.revokedAt || ['CLOSED', 'CLOSING'].includes(s.status ?? '') || Date.parse(s.expiresAt) <= deps.now()) throw new HttpError(409, 'Expired or revoked sessions cannot be extended');
  await authorizeDerivedToken(s, { repo: deps.repo, now: deps.now, currentUser: deps.currentUser });
  const expires = Math.min(deps.now() + ttlMinutes * 60_000, Date.parse(s.createdAt) + MAX_LIFETIME_MS,
    hasTokenBinding(s) ? Date.parse(s.tokenExpiresAt!) : Infinity);
  if (expires <= Date.parse(s.expiresAt)) throw badRequest('Extension must increase expiry within the 24-hour session limit');
  return save(s, { expiresAt: new Date(expires).toISOString() }, deps);
}
export function publicSession(s: Session, principal: Principal) {
  const own = isOwner(s, principal), active = !s.revokedAt && !['CLOSING', 'CLOSED'].includes(s.status ?? '');
  const tokenWrite = principal.authMethod !== 'token' || principal.role === 'researcher' &&
    principal.tokenProjectId === s.projectId && !!principal.scopes?.includes('sessions:write');
  const tokenLaunch = principal.authMethod !== 'token' || tokenWrite && s.authMethod === 'token' &&
    s.tokenId === principal.tokenId && s.tokenProjectId === principal.tokenProjectId && s.tokenRole === principal.role;
  return { id: s.id, kind: s.kind, projectId: s.projectId, backendId: backendId(s.backendId), namespace: s.namespace, owner: s.owner, queue: s.queue,
    createdAt: s.createdAt, expiresAt: s.expiresAt, status: s.status ?? 'LEGACY', message: s.message, logDir: s.logDir,
    workflowId: s.workflowId, taskName: s.taskName, replicaIndex: s.replicaIndex, attempt: s.attempt,
    canOpen: tokenLaunch && own && active && s.status === 'READY' && !!s.ownerSubject && !!s.expiresAt && !!s.podUid,
    canExtend: tokenLaunch && own && active && !!s.ownerSubject && !!s.expiresAt,
    canEnd: tokenWrite && (s.status !== 'CLOSED' || s.managedJob === undefined) && (own || principal.role === 'admin'),
  };
}
export async function listSessionsWithStatus(principal: Principal, deps = defaults()) {
  assertTokenRequestProject(principal, principal.tokenProjectId, false);
  const sessions = (await deps.repo.listSessions()).filter((s) => s.kind !== 'dcv' && (isOwner(s, principal) || principal.role === 'admin') &&
    (principal.authMethod !== 'token' || s.projectId === principal.tokenProjectId));
  return Promise.all(sessions.map(async (s) => {
    try { return publicSession(await refresh(s, deps), principal); }
    catch (error) {
      // Surface read/reconcile failure; never report successful deletion or fake readiness.
      const latest = await deps.repo.getSession(s.id) ?? s;
      return { ...publicSession(latest, principal), canOpen: false, canExtend: false,
        message: error instanceof HttpError && error.status < 500 ? error.message : 'Session reconciliation failed; retry or contact an administrator' };
    }
  }));
}
export async function cleanupExpiredSessions(deps = defaults()): Promise<void> {
  const failures: unknown[] = [];
  for (const s of await deps.repo.listSessions()) {
    if (s.kind === 'dcv' || s.status === 'CLOSED' && !s.managedJob) continue;
    try { await refresh(s, deps); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Session cleanup/reconciliation failed');
}
export async function cancelRunSessions(wf: Pick<Workflow, 'id' | 'namespace'>, filter: { groupId?: string; attempt?: number } = {}, deps = defaults()): Promise<boolean> {
  const matches = (await deps.repo.listSessions()).filter((s) => s.kind !== 'dcv' && s.workflowId === wf.id && s.namespace === wf.namespace &&
    (filter.groupId === undefined || s.groupId === filter.groupId) && (filter.attempt === undefined || s.attempt === filter.attempt));
  const failures: unknown[] = []; let done = true;
  for (const s of matches) { try { if ((await close(s, deps)).status !== 'CLOSED') done = false; } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'Workflow session cancellation failed');
  return done;
}
export async function taskConnectionOptions(workflowId: string, taskName: string, principal: Principal, project: Project, deps = defaults()): Promise<{ replicas: Array<{ replicaIndex: number; ports: string[] }> }> {
  if (currentBackend()?.id !== backendId(project.backendId)) return runOnBackend(project, () => taskConnectionOptions(workflowId, taskName, principal, project, deps), deps.repo);
  assertTokenRequestProject(principal, project.id, false);
  const wf = await deps.repo.getWorkflow(workflowId);
  if (!wf || wf.ownerSubject !== subject(principal) || wf.projectId !== project.id || wf.status !== 'RUNNING') throw forbidden('Only your own running project workflow can be attached');
  const task = (await deps.repo.listTasks(wf.id)).find((t) => t.name === taskName);
  if (!task || task.phase !== 'RUNNING') throw new HttpError(409, 'Task is not running');
  const replicas = [];
  for (let replicaIndex = 0; replicaIndex < Math.max(1, Math.min(64, task.replicas ?? 1)); replicaIndex++) {
    try {
      const { pod } = await taskTarget(wf.id, task.name, replicaIndex, principal, project, deps);
      const ports = pod.spec.containers.find((c) => c.name === 'main')?.ports ?? [];
      replicas.push({ replicaIndex, ports: ports.filter((p) => p.name && (!p.protocol || p.protocol === 'TCP')).map((p) => p.name!) });
    } catch (e) { if (!(e instanceof HttpError && e.status === 409)) throw e; }
  }
  return { replicas };
}
/** DCV targets on HyperPod nodes: SSM target strings + ready-to-run port-forward commands (mirrors scripts/eks/dcv-target.sh). */
export async function hyperPodDcvTargets() {
  const c = config();
  const out: { cluster: string; orchestrator: string; group: string; instanceId: string; instanceType: string; status: string; target: string; portForward: string; login: string }[] = [];
  const clusters = [c.eks?.hyperPodClusterName, c.slurm?.hyperPodClusterName].filter(Boolean) as string[];
  for (const name of clusters) {
    try {
      const d = await hp.describeCluster(name);
      const clusterId = d.ClusterArn?.split('/').pop() ?? '';
      const nodes = await hp.listNodes(name);
      const isEks = Boolean(d.Orchestrator?.Eks);
      for (const n of nodes) {
        const isGpu = /^ml\.(g|p)/.test(n.InstanceType ?? '');
        const isHead = n.InstanceGroupName === 'head';
        if (isHead || (!isGpu && isEks)) continue; // DCV runs on GPU nodes (EKS) or GPU/CPU compute nodes (Slurm)
        const target = `sagemaker-cluster:${clusterId}_${n.InstanceGroupName}-${n.InstanceId}`;
        out.push({
          cluster: name,
          orchestrator: isEks ? 'eks' : 'slurm',
          group: n.InstanceGroupName ?? '',
          instanceId: n.InstanceId ?? '',
          instanceType: n.InstanceType ?? '',
          status: n.InstanceStatus?.Status ?? '',
          target,
          portForward: `aws ssm start-session --region ${c.region} --target ${target} --document-name AWS-StartPortForwardingSession --parameters portNumber=8443,localPortNumber=8444`,
          login: isEks ? 'ec2-user / hyperpod' : 'ubuntu / hyperpod',
        });
      }
    } catch {
      /* cluster missing */
    }
  }
  return out;
}
