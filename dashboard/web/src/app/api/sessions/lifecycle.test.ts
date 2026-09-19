import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { createManagedSession, deleteSession, extendSession, launchSession, cleanupExpiredSessions, cancelRunSessions, listSessionsWithStatus, taskConnectionOptions, type SessionDeps } from '@/server/services/sessions';
import type { Session, Workflow } from '@/server/store/types';
import type { Project } from '@/server/auth/projects';
import { authorizeCookie, consumeTicket } from '@/server/gateway/auth';
import { resolveRoute } from '@/server/gateway/routing';
import { tokenFixture } from '@/server/gateway/token-fixtures.test-helpers';

let repo: Repo, deps: SessionDeps;
let jobs: Map<string, any>, pods: any[], creations: any[], deletions: string[], holdDeletion: boolean, deletionError: boolean;
let now: number;
const principal = { subject: 'subject-a', user: 'alice', email: '', role: 'researcher' as const };
const project: Project = { id: 'team-a', namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue', name: 'A',
  members: { 'subject-a': 'researcher' }, credentialRefs: [], createdAt: 'now', updatedAt: 'now' };
beforeEach(async () => {
  repo = new Repo(new MemoryKV()); jobs = new Map(); pods = []; creations = []; deletions = []; holdDeletion = false; deletionError = false;
  now = Date.now();
  await repo.kv.put({ pk: 'PROJECT#team-a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: project.id, ...project });
  deps = { repo, now: () => now, image: 'registry/workspace@sha256:' + 'a'.repeat(64), runtimeImage: 'registry/runtime@sha256:' + 'b'.repeat(64),
    k8s: {
      prepare: async () => undefined,
      getJob: async (_ns, name) => jobs.get(name) ?? null,
      createJob: async (_ns, manifest) => {
        const job = structuredClone(manifest) as any; job.metadata.uid = 'job-uid'; jobs.set(job.metadata.name, job); creations.push(job); return job;
      },
      listPods: async (_ns, selector) => pods.filter((p) => selector.split(',').every((part) => { const [key, value] = part.split('='); return p.metadata.labels[key] === value; })),
      getPod: async (_ns, name) => pods.find((p) => p.metadata.name === name) ?? null,
      deleteObject: async (ns, kind, name, uid) => {
        if (deletionError) throw new Error('Kubernetes deletion refused'); deletions.push(`${kind}/${name}`);
        if (!holdDeletion) { if (kind === 'jobs') jobs.delete(name); if (kind === 'pods') pods = pods.filter((p) => p.metadata.uid !== uid); }
      },
      listLegacy: async () => [],
    },
  };
});
async function create(kind: 'jupyter'|'tensorboard'|'code-server' = 'jupyter') {
  return createManagedSession(kind === 'tensorboard'
    ? { kind, ttlMinutes: 60, logDir: '/fsx/checkpoints/projects/team-a/runs/run-a/train' }
    : { kind, ttlMinutes: 60 }, principal, project, deps);
}
async function ready(s: Session) {
  const job = jobs.get(s.name); job.spec.suspend = false;
  pods = [{ metadata: { name: 'session-pod', uid: 'pod-uid', labels: job.metadata.labels,
    ownerReferences: [{ kind: 'Job', name: s.name, uid: job.metadata.uid, controller: true }] },
    spec: { nodeName: 'node-a', containers: [{ name: 'workspace', ports: [{ name: 'app', containerPort: s.port ?? 8888 }] }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'workspace', ready: true }] } }];
  await listSessionsWithStatus(principal, deps);
  return (await repo.getSession(s.id))!;
}

describe('managed development sessions', () => {
  it.each(['jupyter', 'tensorboard', 'code-server'] as const)('creates a queued isolated %s Job with loopback readiness and no user AWS credentials', async (kind) => {
    const session = await create(kind); const job = creations[0];
    expect(session).toMatchObject({ status: 'QUEUED', ownerSubject: principal.subject, projectId: project.id, namespace: project.namespace, queue: project.queue });
    expect(job).toMatchObject({ kind: 'Job', metadata: { labels: { 'kueue.x-k8s.io/queue-name': project.queue } }, spec: { suspend: true, backoffLimit: 0 } });
    const pod = job.spec.template.spec, app = pod.containers[0];
    expect(pod.automountServiceAccountToken).toBe(false); expect(pod.serviceAccountName).toBe('pai-workload');
    expect(app.securityContext).toMatchObject({ runAsNonRoot: true, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(app.readinessProbe.exec.command).toEqual(['python', '/opt/pai/session.py', '--ready', kind]);
    expect(app.volumeMounts.find((m: any) => m.mountPath === '/workspace')).toMatchObject({ subPath: `sessions/projects/team-a/${session.id}` });
    expect(app.volumeMounts.some((m: any) => ['/fsx', '/pai-fsx'].includes(m.mountPath))).toBe(false);
    expect(pod.initContainers[0].command).toContain('/opt/pai/prepare.py');
    expect(pod.initContainers[1]).toMatchObject({
      name: 'verify-workspace-isolation', image: deps.runtimeImage,
      command: ['/opt/pai/runtime', '--verify-isolation'],
      securityContext: { runAsUser: 1000, runAsNonRoot: true, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    });
    expect(pod.initContainers[1]).not.toHaveProperty('volumeMounts');
    expect(pod.initContainers[1]).not.toHaveProperty('env');
    expect(JSON.stringify(app)).not.toMatch(/pip install|PAI_RUNTIME_TOKEN|AWS_ACCESS_KEY_ID|AWS_ROLE_ARN/);
    if (kind === 'tensorboard') expect(app.volumeMounts.find((m: any) => m.mountPath === '/logs')).toMatchObject({ readOnly: true, subPath: 'checkpoints/projects/team-a/runs/run-a/train' });
  });
  it('injects PAI_SESSION_PREFIX empty in host mode and /s/<id> in path mode', async () => {
    try {
      vi.stubEnv('GATEWAY_MODE', 'host');
      await create();
      const hostEnv = creations[0].spec.template.spec.containers[0].env;
      expect(hostEnv).toEqual(expect.arrayContaining([{ name: 'PAI_SESSION_PREFIX', value: '' }]));

      vi.stubEnv('GATEWAY_MODE', 'path');
      const pathSession = await create();
      const pathEnv = creations[1].spec.template.spec.containers[0].env;
      expect(pathEnv).toEqual(expect.arrayContaining([{ name: 'PAI_SESSION_PREFIX', value: `/s/${pathSession.id}` }]));
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('rejects managed creation before writing intent if the isolation runtime image is absent', async () => {
    deps.runtimeImage = undefined;
    await expect(create()).rejects.toMatchObject({ status: 503 });
    expect(creations).toHaveLength(0);
    expect(await repo.listSessions()).toEqual([]);
  });
  it('rejects browser namespace/target overrides, missing stable identity, and cross-project log paths', async () => {
    await expect(createManagedSession({ kind: 'jupyter', namespace: 'kube-system' } as any, principal, project, deps)).rejects.toBeDefined();
    await expect(createManagedSession({ kind: 'tensorboard', logDir: '/fsx/checkpoints/projects/other/run' }, principal, project, deps)).rejects.toBeDefined();
    await expect(createManagedSession({ kind: 'tensorboard', logDir: '/fsx/checkpoints/projects/team-a/../other' }, principal, project, deps)).rejects.toBeDefined();
    await expect(createManagedSession({ kind: 'jupyter' }, { ...principal, subject: undefined }, project, deps)).rejects.toBeDefined();
    expect(creations).toHaveLength(0);
  });
  it('launches only a ready, owned pod UID and returns no ticket/target through public listing', async () => {
    const s = await create();
    await expect(launchSession(s.id, principal, deps)).rejects.toMatchObject({ status: 409 });
    const registered = await ready(s);
    expect(registered).toMatchObject({ status: 'READY', podName: 'session-pod', podUid: 'pod-uid', nodeName: 'node-a' });
    const launch = await launchSession(s.id, principal, deps); expect(launch.url).toMatch(/^https:\/\/.*\.apps\.physical-ai\.hi-yoo\.com\/\?ticket=/);
    const publicList = await listSessionsWithStatus(principal, deps);
    expect(publicList[0]).toMatchObject({ canOpen: true, canEnd: true });
    for (const field of ['podName', 'podUid', 'ssmTarget', 'dcvSessionId', 'ticket', 'token', 'container']) expect(publicList[0]).not.toHaveProperty(field);
    await expect(launchSession(s.id, { ...principal, subject: 'other', role: 'admin' }, deps)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a substituted pod with the same name but different owner UID', async () => {
    const s = await ready(await create());
    pods[0].metadata.uid = 'attacker'; pods[0].metadata.ownerReferences[0].uid = 'other-job';
    await expect(launchSession(s.id, principal, deps)).rejects.toBeDefined();
  });
  it('keeps CLOSING and revoked until Job and pods are actually absent', async () => {
    const s = await ready(await create()); holdDeletion = true;
    const closing = await deleteSession(s.id, principal, deps);
    expect(closing.status).toBe('CLOSING'); expect((await repo.getSession(s.id))?.revokedAt).toBeTruthy();
    expect(jobs.size).toBe(1); expect(pods).toHaveLength(1);
    holdDeletion = false; await cleanupExpiredSessions(deps);
    expect((await repo.getSession(s.id))?.status).toBe('CLOSED'); expect(jobs.size).toBe(0); expect(pods).toHaveLength(0);
  });
  it('propagates deletion errors while preserving revocation and retries on the next sweep', async () => {
    const s = await ready(await create()); deletionError = true;
    await expect(deleteSession(s.id, principal, deps)).rejects.toThrow('Kubernetes deletion refused');
    expect((await repo.getSession(s.id))?.status).toBe('CLOSING');
    deletionError = false; await cleanupExpiredSessions(deps);
    expect((await repo.getSession(s.id))?.status).toBe('CLOSED');
  });
  it('fences an in-flight Job create when end arrives first and cleans a late result', async () => {
    const original = deps.k8s.createJob;
    let resume!: () => void;
    deps.k8s.createJob = async (...args) => { await new Promise<void>((resolve) => { resume = resolve; }); return original(...args); };
    const creating = create();
    while (!resume) await new Promise((resolve) => setImmediate(resolve));
    const intent = (await repo.listSessions())[0];
    expect((await deleteSession(intent.id, principal, deps)).status).toBe('CLOSING');
    resume();
    await creating;
    expect(jobs.size).toBe(0);
    expect((await repo.getSession(intent.id))?.status).toBe('CLOSED');
  });
  it('detects and removes a late Job even when its previous row was CLOSED', async () => {
    const s = await create(); const lateJob = structuredClone(jobs.get(s.name));
    await deleteSession(s.id, principal, deps);
    jobs.set(s.name, lateJob);
    await cleanupExpiredSessions(deps);
    expect(jobs.size).toBe(0);
    expect((await repo.getSession(s.id))?.status).toBe('CLOSED');
  });
  it('expires queued and ready sessions and bounds extension to the maximum lifetime', async () => {
    const s = await create();
    now += 30 * 60_000;
    const extended = await extendSession(s.id, 120, principal, deps);
    expect(Date.parse(extended.expiresAt!)).toBe(now + 120 * 60_000);
    await expect(extendSession(s.id, 1441, principal, deps)).rejects.toBeDefined();
    now = Date.parse(extended.expiresAt!); await cleanupExpiredSessions(deps);
    expect((await repo.getSession(s.id))?.status).toBe('CLOSED');
  });
  it('allows legacy removal by owner/admin but rejects legacy launch', async () => {
    await repo.putSession({ id: 'legacy', name: 'tb-legacy', kind: 'tensorboard', owner: 'alice', namespace: project.namespace, createdAt: new Date(now).toISOString() });
    await expect(launchSession('legacy', principal, deps)).rejects.toBeDefined();
    expect((await deleteSession('legacy', principal, deps)).status).toBe('CLOSED');
    expect(await repo.getSession('legacy')).toBeUndefined();
  });
});

async function workflow() {
  const wf = { id: 'run-a', projectId: project.id, ownerSubject: principal.subject, owner: principal.user, namespace: project.namespace, status: 'RUNNING',
    spec: { workflow: { tasks: [{ name: 'train', parallelism: 1 }] } }, createdAt: 'now', updatedAt: 'now' } as unknown as Workflow;
  await repo.putWorkflow(wf);
  await repo.kv.put({ pk: 'WF#run-a', sk: 'TASK#train', workflowId: wf.id, name: 'train', phase: 'RUNNING', attempts: 2, attemptEpoch: 'epoch-2', groupId: 'group-a', jobName: 'training-job', jobUid: 'training-uid' });
  pods = [{ metadata: { name: 'train-pod', uid: 'training-pod-uid', labels: { 'app.kubernetes.io/managed-by': 'physical-ai-dashboard', 'pai.aws/workflow-id': 'run-a', 'pai.aws/task': 'train', 'pai.aws/attempt': '2', 'pai.aws/epoch': 'epoch-2', 'batch.kubernetes.io/job-completion-index': '0' } },
    spec: { nodeName: 'node-b', containers: [{ name: 'main', ports: [{ name: 'metrics', containerPort: 9090 }] }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'main', ready: true }] } }];
  return wf;
}
async function completeWorkflow(wf: Workflow) {
  await repo.putWorkflow({ ...wf, status: 'SUCCEEDED' });
  const task = (await repo.kv.get(`WF#${wf.id}`, 'TASK#train'))!;
  await repo.kv.put({ ...task, phase: 'SUCCEEDED' });
  pods = []; // The training pod is gone; only persisted FSx data remains.
}

describe('post-completion TensorBoard contract', () => {
  it('creates and launches an independent managed TensorBoard after training succeeded and its pod is gone', async () => {
    const wf = await workflow(); await completeWorkflow(wf);
    const s = await createManagedSession({
      kind: 'tensorboard', ttlMinutes: 60,
      logDir: '/fsx/checkpoints/projects/team-a/runs/run-a/attempts/2/train/logs',
    }, principal, project, deps);
    expect(s).toMatchObject({ managedJob: true, ownerSubject: principal.subject, projectId: project.id, status: 'QUEUED', port: 6006 });
    for (const key of ['workflowId', 'taskName', 'attempt', 'attemptEpoch']) expect(s).not.toHaveProperty(key);
    const registered = await ready(s);
    expect(registered).toMatchObject({ status: 'READY', podUid: 'pod-uid', podName: 'session-pod' });
    const url = new URL((await launchSession(s.id, principal, deps)).url);
    const { cookie } = await consumeTicket(url.searchParams.get('ticket')!, resolveRoute({ host: url.host, path: '/' }, { repo, now: deps.now }), { repo, now: deps.now });
    expect((await authorizeCookie(cookie.split(';')[0], resolveRoute({ host: url.host, path: '/' }, { repo, now: deps.now }), { repo, now: deps.now })).id).toBe(s.id);
    expect(await cancelRunSessions(wf, { attempt: 2 }, deps)).toBe(true);
    expect((await repo.getSession(s.id))?.status).toBe('READY');
  });

  it.each(['terminal', 'port-forward'] as const)('blocks completed-workflow %s creation and invalidates its old live-attempt cookie', async (kind) => {
    const wf = await workflow();
    pods[0].spec.containers[0].ports.push({ name: 'pai-files', containerPort: 8077 });
    const input = kind === 'terminal'
      ? { kind, workflowId: wf.id, taskName: 'train' }
      : { kind, workflowId: wf.id, taskName: 'train', portName: 'pai-files' };
    const live = await createManagedSession(input, principal, project, deps);
    const url = new URL((await launchSession(live.id, principal, deps)).url);
    const { cookie } = await consumeTicket(url.searchParams.get('ticket')!, resolveRoute({ host: url.host, path: '/' }, { repo, now: deps.now }), { repo, now: deps.now });
    await completeWorkflow(wf);
    await expect(createManagedSession(input, principal, project, deps)).rejects.toMatchObject({ status: 409 });
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host: url.host, path: '/' }, { repo, now: deps.now }), { repo, now: deps.now })).rejects.toMatchObject({ status: 401 });
  });

  it('keeps post-completion TensorBoard subject to its source API-token revocation', async () => {
    const source = await tokenFixture(); repo = source.repo; await repo.deleteSession('derived');
    deps = { ...deps, repo, now: source.options.now!, currentUser: source.options.currentUser };
    const wf = await workflow(); await completeWorkflow(wf);
    const s = await createManagedSession({
      kind: 'tensorboard', logDir: '/fsx/checkpoints/projects/team-a/runs/run-a/attempts/2/train/logs', ttlMinutes: 60,
    }, source.principal, source.project, deps);
    await ready(s);
    const url = new URL((await launchSession(s.id, source.principal, deps)).url);
    const { cookie } = await consumeTicket(url.searchParams.get('ticket')!, resolveRoute({ host: url.host, path: '/' }, source.options), source.options);
    await source.revoke();
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host: url.host, path: '/' }, source.options), source.options)).rejects.toMatchObject({ status: 401 });
  });
});

describe('task attachments', () => {
  it.each([[true, true], [true, false], [false, true]])('keeps exec but denies shared-host HTTP (pin=%s pod=%s)', async (pinHostNetwork, podHostNetwork) => {
    const wf = await workflow();
    await repo.kv.put({ ...(await repo.kv.get(`WF#${wf.id}`, 'META'))!, executionProfilePins: { train: { nodes: [{ name: 'node-b', uid: 'node-uid' }], policy: { hostNetwork: pinHostNetwork } } } });
    const admin = { ...principal, role: 'admin' as const, authMethod: 'alb' as const };
    deps.currentUser = async () => ({ enabled: true, username: principal.user, email: '', subject: principal.subject, groups: ['admins'] });
    deps.validateExecutionProfile = async () => {};
    await repo.kv.put({ pk: `WF#${wf.id}`, sk: 'RUNTIME#epoch-2#META', released: true });
    await repo.kv.put({ pk: `WF#${wf.id}`, sk: 'RUNTIME#epoch-2#MEMBER#train#0', phase: 'RUNNING', processStarted: true, readyEver: true });
    pods[0].spec.hostNetwork = podHostNetwork;
    await expect(createManagedSession({ kind: 'terminal', workflowId: wf.id, taskName: 'train' }, principal, project, deps)).rejects.toMatchObject({ status: 403 });
    const shell = await createManagedSession({ kind: 'terminal', workflowId: wf.id, taskName: 'train' }, admin, project, deps);
    expect(shell).toMatchObject({ podUid: 'training-pod-uid', hostNetwork: true });
    await expect(launchSession(shell.id, admin, deps)).resolves.toHaveProperty('url');
    await expect(createManagedSession({ kind: 'port-forward', workflowId: wf.id, taskName: 'train', portName: 'metrics' }, principal, project, deps)).rejects.toMatchObject({ status: 403 });
    expect((await taskConnectionOptions(wf.id, 'train', principal, project, deps)).replicas[0].ports).toEqual([]);
  });
  it('binds owner, actual task labels, pod UID, epoch and registered port name', async () => {
    await workflow();
    const s = await createManagedSession({ kind: 'port-forward', workflowId: 'run-a', taskName: 'train', portName: 'metrics' }, principal, project, deps);
    expect(s).toMatchObject({ managedJob: false, podName: 'train-pod', podUid: 'training-pod-uid', attempt: 2, attemptEpoch: 'epoch-2', container: 'main', port: 9090 });
    expect(creations).toHaveLength(0);
    await expect(createManagedSession({ kind: 'port-forward', workflowId: 'run-a', taskName: 'train', portName: 'unregistered' }, principal, project, deps)).rejects.toBeDefined();
  });
  it('rejects old attempts and other workflow owners', async () => {
    await workflow(); pods[0].metadata.labels['pai.aws/attempt'] = '1';
    await expect(createManagedSession({ kind: 'terminal', workflowId: 'run-a', taskName: 'train' }, principal, project, deps)).rejects.toBeDefined();
    await workflow();
    await expect(createManagedSession({ kind: 'terminal', workflowId: 'run-a', taskName: 'train' }, { ...principal, subject: 'other', role: 'admin' }, project, deps)).rejects.toBeDefined();
  });
  it('revokes only matching group/attempt attachments without deleting training pods', async () => {
    const wf = await workflow();
    const s = await createManagedSession({ kind: 'terminal', workflowId: 'run-a', taskName: 'train' }, principal, project, deps);
    expect(await cancelRunSessions(wf, { groupId: 'other', attempt: 2 }, deps)).toBe(true);
    expect((await repo.getSession(s.id))?.status).toBe('READY');
    expect(await cancelRunSessions(wf, { groupId: 'group-a', attempt: 2 }, deps)).toBe(true);
    expect((await repo.getSession(s.id))?.status).toBe('CLOSED'); expect(pods).toHaveLength(1); expect(deletions).toHaveLength(0);
  });
});
