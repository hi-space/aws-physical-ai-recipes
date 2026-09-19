import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { EventEmitter } from 'node:events';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { config, resetConfigForTests } from '../config';
import { createProject, type Project } from '../auth/projects';
import { submitWorkflow, reconcileWorkflow, cancelWorkflow } from '../workflow/controller';
import { productionControllerDeps } from '../workflow-adapters/dependencies';
import { k8sJson, clusterInfo } from '../k8s/client';
import { backendConfig, runOnBackend } from './context';
import { registerBackend, inspectBackend } from './registry';
import { admin, profile } from './test-fixtures';
import { probeBackend } from './probe';
import { withRequestBackend } from './request';
import { GET as listJobsRoute } from '@/app/api/k8s/jobs/route';
import { POST as submitRoute } from '@/app/api/workflows/route';
import { createManagedSession, deleteSession, listSessionsWithStatus } from '../services/sessions';
import { createKubernetesTransport } from '../gateway/kubernetes';
import { sessionBinding } from '../gateway/auth';
import { RuntimeBroker } from '../runtime/broker';
import type { Workflow, Session } from '../store/types';
import type { ObjectStorage } from '../runtime/storage';
import type { Job, Pod } from '../k8s/resources';
import type { JobSet } from '../workflow/ports';
import { allowedBuckets } from '../aws/s3';
import { artifactPublisher, cancelArtifactCollectors } from '../workflow-adapters/artifacts';

const fake = vi.hoisted(() => ({
  repo: undefined as unknown as Repo,
  send: vi.fn(), fsxSend: vi.fn(), fetch: vi.fn(), sockets: [] as Array<{ url: string; headers: Record<string, string> }>,
}));
vi.mock('../store/repo', async original => ({ ...await original<typeof import('../store/repo')>(), getRepo: () => fake.repo }));
vi.mock('../aws/clients', async original => {
  const real = await original<typeof import('../aws/clients')>();
  return { ...real, eks: () => ({ send: fake.send }), fsx: () => ({ send: fake.fsxSend }),
    s3: () => { throw new Error('No live S3 calls allowed'); }, ssm: () => { throw new Error('No live credential calls allowed'); } };
});
vi.mock('../notify', () => ({ notify: async () => undefined }));
vi.mock('../k8s/token', () => ({ mintEksToken: async (name: string, region: string) => ({ token: `token:${region}:${name}`, expiresAt: Date.now() + 60000 }) }));
vi.mock('undici', () => ({ Agent: class { constructor(readonly options: unknown) {} }, fetch: fake.fetch }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 1; protocol = 'v4.channel.k8s.io'; bufferedAmount = 0;
    constructor(url: string, _protocols: string[], options: { headers: Record<string, string> }) {
      super(); fake.sockets.push({ url, headers: options.headers }); queueMicrotask(() => this.emit('open'));
    }
    terminate() { this.readyState = 3; this.emit('close'); } close() { this.terminate(); }
    pause() {} resume() {} send(_data: unknown, _options: unknown, callback?: () => void) { callback?.(); }
  } };
});

const ns = 'hyperpod-ns-team-a';
const yaml = `workflow:
  name: routing
  resources: { cpu: { cpu: 1, memory: 1Gi } }
  tasks:
    - name: train
      resource: cpu
      image: example.test/torch:v1
      command: [python, train.py]
`;
let projects: Project[];
let jobs: Record<string, Map<string, Job>>;
let jobsets: Record<string, Map<string, JobSet>>;
let pods: Record<string, Pod[]>;
let calls: Array<{ cluster: string; path: string; method: string; body?: Record<string, unknown> }>;
let denied: boolean;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  for (const [key, value] of Object.entries({
    AUTH_MODE: 'alb', TABLE_NAME: 'home-table', AWS_REGION: 'us-east-1', ACCOUNT_ID: '123456789012', BACKEND_HOME_VPC_ID: 'vpc-1234',
    EKS_CLUSTER_NAME: 'home', HYPERPOD_EKS_CLUSTER_NAME: 'hp-home', EKS_DATA_BUCKET: 'data-home',
    FSX_FILE_SYSTEM_ID: 'fs-home', FSX_DNS_NAME: 'home.fsx.test', FSX_MOUNT_NAME: 'mount',
    DASHBOARD_ARTIFACT_BUCKET: 'home-archive', ARTIFACTS_BUCKET: 'home-sagemaker', SM_PIPELINE_NAME: 'native-pipeline',
    TASK_RUNTIME_IMAGE: 'example.test/runtime:v1', RUNTIME_API_URL: 'http://home-runtime.internal',
    MUJOCO_IMAGE_URI: 'example.test/mujoco:v1',
    RUNTIME_SIGNING_KEY: 'test-signing-key-that-is-over-32-bytes', IMAGE_PROFILES_ENFORCED: '0',
    EKS_BACKENDS_JSON: JSON.stringify([profile('alpha'), profile('beta')]),
  })) vi.stubEnv(key, value);
  resetConfigForTests(); fake.repo = new Repo(new MemoryKV()); fake.sockets = []; fake.send.mockReset(); fake.fsxSend.mockReset(); fake.fetch.mockReset();
  jobs = { home: new Map(), 'eks-alpha': new Map(), 'eks-beta': new Map() }; pods = { home: [], 'eks-alpha': [], 'eks-beta': [] };
  jobsets = { home: new Map(), 'eks-alpha': new Map(), 'eks-beta': new Map() };
  calls = []; denied = false;
  fake.send.mockImplementation(async ({ input }: { input: { name: string } }) => ({
    cluster: { name: input.name, arn: `arn:aws:eks:us-east-1:123456789012:cluster/${input.name}`, status: 'ACTIVE',
      endpoint: `https://${input.name}.eks.test`, certificateAuthority: { data: Buffer.from(`ca:${input.name}`).toString('base64') },
      resourcesVpcConfig: { vpcId: 'vpc-1234', endpointPrivateAccess: true } },
  }));
  fake.fsxSend.mockImplementation(async ({ input }: { input: { Filters: Array<{ Values: string[] }> } }) => {
    const fsId = input.Filters[0].Values[0];
    return { Associations: [{ FileSystemId: fsId, AssociationId: `dra-${fsId}`, Lifecycle: 'AVAILABLE',
      FileSystemPath: '/checkpoints', DataRepositoryPath: `s3://data-${fsId.slice(3)}/checkpoints/`, S3: { AutoExportPolicy: { Events: ['NEW', 'CHANGED'] } } }] };
  });
  fake.fetch.mockImplementation(async (target: string, init: { method: string; body?: string; headers: Record<string, string>; dispatcher: { options: { connect: { ca: string } } } }) => {
    const url = new URL(target), cluster = url.hostname.split('.')[0], path = url.pathname;
    expect(init.headers.authorization).toBe(`Bearer token:us-east-1:${cluster}`);
    expect(init.dispatcher.options.connect.ca).toBe(`ca:${cluster}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ cluster, path, method: init.method, body });
    if (path === '/version') return response({ gitVersion: 'v1.33.0' });
    if (path === '/apis/jobset.x-k8s.io/v1alpha2') return response({ resources: [{ name: 'jobsets' }] });
    if (path.endsWith('/selfsubjectaccessreviews')) return response({ status: { allowed: !denied } });
    if (path === `/api/v1/namespaces/${ns}`) return response({ status: { phase: 'Active' } });
    if (path.includes('/localqueues/')) return response({ spec: { clusterQueue: 'team-a' } });
    if (path.endsWith('/persistentvolumeclaims/fsx-pvc')) return response({ spec: { volumeName: 'fsx-volume' }, status: { phase: 'Bound' } });
    if (path.includes('/persistentvolumes/')) return response({ spec: { csi: { driver: 'fsx.csi.aws.com', volumeHandle: `fs-${cluster.replace('eks-', '')}`,
      volumeAttributes: { dnsname: `${cluster.replace('eks-', '')}.fsx.test`, mountname: 'mount' } }, claimRef: { namespace: ns, name: 'fsx-pvc' } } });
    if (path.includes('/serviceaccounts/')) return response({ metadata: {} });
    if (path.endsWith('/pods')) return response({ items: pods[cluster] });
    if (/\/pods\/[^/]+\/log$/.test(path)) return new Response(`logs from ${cluster}`);
    if (path.includes('/pods/')) return response(pods[cluster].find(p => p.metadata.name === path.split('/').pop()) ?? {}, 200);
    if (path.endsWith('/jobs') && init.method === 'POST') {
      const job = body as unknown as Job; job.metadata.uid = `uid:${cluster}:${job.metadata.name}`; jobs[cluster].set(job.metadata.name, job); return response(job, 201);
    }
    if (path.endsWith('/jobsets') && init.method === 'POST') {
      const set = body as unknown as JobSet; set.metadata.uid = `uid:${cluster}:${set.metadata.name}`; jobsets[cluster].set(set.metadata.name, set); return response(set, 201);
    }
    if (path.endsWith('/secrets') && init.method === 'POST') {
      const secret = body as { metadata: { name: string; uid?: string } };
      secret.metadata.uid = `uid:${cluster}:secret:${secret.metadata.name}`;
      return response(secret, 201);
    }
    if (path.includes('/jobsets/')) {
      const name = path.split('/').pop()!;
      if (init.method === 'DELETE') { jobsets[cluster].delete(name); return response({}); }
      return jobsets[cluster].has(name) ? response(jobsets[cluster].get(name)) : response({}, 404);
    }
    if (path.endsWith('/jobs')) return response({ items: [...jobs[cluster].values()] });
    if (path.includes('/jobs/')) {
      const name = path.split('/').pop()!;
      if (init.method === 'DELETE') { jobs[cluster].delete(name); pods[cluster] = []; return response({}); }
      return jobs[cluster].has(name) ? response(jobs[cluster].get(name)) : response({ message: 'not found' }, 404);
    }
    if (/\/(?:configmaps|secrets)\/[^/]+$/.test(path) && init.method === 'GET') return response({}, 404);
    return response({ items: [] });
  });
  projects = [];
  for (const id of ['alpha', 'beta']) {
    await registerBackend(admin, { id, enabled: true, expectedVersion: 0 }, fake.repo);
    const checked = await inspectBackend(admin, id, 1, fake.repo, probeBackend);
    expect(checked.status).toBe('READY');
    projects.push(await createProject(admin, { id, name: id, backendId: id, namespace: ns, members: { alice: 'researcher' } }, fake.repo));
  }
  calls = [];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigForTests(); });
const principal = { user: 'alice', subject: 'alice', email: 'alice@test', role: 'researcher' as const };
function request(path: string, project: string, method = 'GET', body?: unknown) {
  return new NextRequest(`https://dashboard.test${path}`, { method, headers: {
    'x-pai-user': 'alice', 'x-pai-subject': 'alice', 'x-pai-email': 'alice@test', 'x-pai-role': 'researcher',
    'x-pai-project': project, origin: 'https://dashboard.test', ...(body ? { 'content-type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function submitted(project: Project, source = yaml) {
  return submitWorkflow({ yaml: source, owner: 'alice', ownerSubject: 'alice', projectId: project.id, namespace: ns, queue: project.queue, deferLaunch: true }, productionControllerDeps());
}

describe('two EKS backends across real application boundaries', () => {
  it('submits through the API and concurrently reconciles each persisted run to its own HTTP client/CA/token/storage', async () => {
    const replies = await Promise.all(projects.map(project => submitRoute(request('/api/workflows', project.id, 'POST', { yaml }))));
    expect(replies.map(r => r.status)).toEqual([202, 202]);
    const runs = await Promise.all(replies.map(r => r.json() as Promise<Workflow>));
    expect(runs.map(w => w.backendId)).toEqual(['alpha', 'beta']);
    expect(runs.every(w => w.backendConfigHash?.length === 64)).toBe(true);
    await Promise.all(runs.map(w => reconcileWorkflow(w, productionControllerDeps())));
    for (const run of runs) expect((await fake.repo.listTasks(run.id)).map(t => t.message)).toEqual([undefined]);
    expect([...jobs['eks-alpha'].values()].map(j => j.metadata.labels?.['pai.aws/workflow-id'])).toEqual([runs[0].id]);
    expect([...jobs['eks-beta'].values()].map(j => j.metadata.labels?.['pai.aws/workflow-id'])).toEqual([runs[1].id]);
    expect(jobs.home.size).toBe(0);
    expect(calls.filter(c => c.path.includes('/persistentvolumes/')).map(c => c.cluster).sort()).toEqual(['eks-alpha', 'eks-beta']);
    expect(config().tableName).toBe('home-table'); expect(config().eks?.eksClusterName).toBe('home');
    expect(await runOnBackend(projects[1], async () => backendConfig().groot?.pipelineName)).toBe('native-pipeline');
    const listings = await Promise.all(projects.map(p => listJobsRoute(request('/api/k8s/jobs', p.id))));
    expect(listings.every(r => r.status === 200)).toBe(true);
    expect(calls.filter(c => c.path.endsWith('/jobs') && c.method === 'GET').slice(-2).map(c => c.cluster).sort()).toEqual(['eks-alpha', 'eks-beta']);
    await registerBackend(admin, { id: 'alpha', expectedVersion: 1, enabled: false }, fake.repo);
    // The selected UI project cannot redirect a known run's cancellation.
    await withRequestBackend(request(`/api/workflows/${runs[0].id}/cancel`, 'beta', 'POST'), principal,
      () => cancelWorkflow(runs[0].id, 'alice', productionControllerDeps()));
    expect(jobs['eks-alpha'].size).toBe(0); expect(jobs['eks-beta'].size).toBe(1);
    expect(calls.filter(c => c.method === 'DELETE' && c.path.includes('/jobs/')).every(c => c.cluster === 'eks-alpha')).toBe(true);
  });

  it('retains default cluster routing and rejects namespace/backend spoofing and revoked backend launches', async () => {
    await k8sJson('/version');
    expect(calls.at(-1)?.cluster).toBe('home');
    const defaultRun = await submitWorkflow({ yaml, owner: 'legacy', deferLaunch: true }, productionControllerDeps());
    await reconcileWorkflow(defaultRun, productionControllerDeps());
    expect(jobs.home.size).toBe(1);
    await expect(withRequestBackend(request('/api/k8s/jobs?backendId=beta', 'alpha'), principal, async () => k8sJson('/version'))).rejects.toThrow();
    await expect(submitWorkflow({ yaml, owner: 'alice', projectId: 'alpha', namespace: ns, queue: projects[0].queue, backendId: 'beta' }, productionControllerDeps())).rejects.toThrow();
    await registerBackend(admin, { id: 'alpha', expectedVersion: 1, enabled: false }, fake.repo);
    const before = calls.length;
    await expect(submitted(projects[0])).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });

  it('routes grouped JobSet launch and cancellation to each backend without creating substitute independent Jobs', async () => {
    const grouped = `workflow:
  name: pair
  resources: { cpu: { cpu: 1, memory: 1Gi } }
  groups:
    - name: gloo
      barrier: true
      tasks:
        - name: train
          resource: cpu
          image: example.test/torch:v1
          command: [python, train.py]
          parallelism: 2
          lead: true
`;
    const runs = await Promise.all(projects.map(p => submitted(p, grouped)));
    await Promise.all(runs.map(w => reconcileWorkflow(w, productionControllerDeps())));
    for (const [index, id] of ['alpha', 'beta'].entries()) {
      const set = [...jobsets[`eks-${id}`].values()][0];
      expect(set.metadata.labels?.['pai.aws/workflow-id']).toBe(runs[index].id);
      expect(set.spec.replicatedJobs[0].template.spec.completions).toBe(2);
      expect(jobs[`eks-${id}`].size).toBe(0);
    }
    await cancelWorkflow(runs[1].id, 'alice', productionControllerDeps());
    expect(jobsets['eks-alpha'].size).toBe(1); expect(jobsets['eks-beta'].size).toBe(0);
  });

  it('uses the dataset owner project backend even when the browser selected another project, retaining home archive and SageMaker buckets', async () => {
    await fake.repo.kv.put({ pk: 'DS#data-alpha', sk: 'META', name: 'data-alpha', projectId: 'alpha' });
    const buckets = await withRequestBackend(request('/api/datasets/data-alpha/versions', 'beta'), principal,
      async () => allowedBuckets().map(b => b.name));
    expect(buckets).toContain('data-alpha'); expect(buckets).not.toContain('data-beta');
    expect(buckets).toContain('home-archive'); expect(buckets).toContain('home-sagemaker');
  });

  it('collects outputs on the source backend FSx and cleans up only that backend collector without claiming unverified success', async () => {
    const runs = await Promise.all(projects.map(p => submitted(p)));
    await Promise.all(runs.map(w => reconcileWorkflow(w, productionControllerDeps())));
    const publications = [];
    for (const run of runs) {
      const task = { ...(await fake.repo.listTasks(run.id))[0], phase: 'FINALIZING' as const };
      await fake.repo.kv.put({ pk: `WF#${run.id}`, sk: `TASK#${task.name}`, ...task });
      publications.push({ workflow: (await fake.repo.getWorkflow(run.id))!, task, output: { dataset: { name: `result-${run.backendId}`, path: '{{output}}' } },
        sourcePath: task.outputPath!, publicationId: `publication-${run.id}`, attempt: task.attempts, signal: new AbortController().signal });
    }
    const results = await Promise.all(publications.map(input => artifactPublisher.publish(input)));
    expect(results.map(r => r.state)).toEqual(['pending', 'pending']);
    expect(fake.fsxSend.mock.calls.map(([command]) => command.input.Filters[0].Values[0]).sort()).toEqual(['fs-alpha', 'fs-beta']);
    const collectors = (id: string) => [...jobs[`eks-${id}`].keys()].filter(name => name.startsWith('pai-inventory-'));
    expect(collectors('alpha')).toHaveLength(1); expect(collectors('beta')).toHaveLength(1);
    expect(await cancelArtifactCollectors(publications[0].workflow, { signal: new AbortController().signal })).toBe(true);
    expect(collectors('alpha')).toHaveLength(0); expect(collectors('beta')).toHaveLength(1);
  });

  it('records failed RBAC probes and prevents any Job submission afterward', async () => {
    denied = true;
    const state = await inspectBackend(admin, 'alpha', 1, fake.repo, probeBackend);
    expect(state.status).toBe('UNREADY');
    expect(state.findings.some(f => f.code.startsWith('rbac:'))).toBe(true);
    await expect(submitted(projects[0])).rejects.toThrow();
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/jobs'))).toBe(false);
  });

  it('routes session discovery and gateway sockets from the persisted backend and invalidates changed grants', async () => {
    const runs = await Promise.all(projects.map(p => submitted(p)));
    await Promise.all(runs.map(w => reconcileWorkflow(w, productionControllerDeps())));
    const sessions: Session[] = [];
    for (const [index, run] of runs.entries()) {
      const cluster = `eks-${run.backendId}`, task = (await fake.repo.listTasks(run.id))[0];
      const job = [...jobs[cluster].values()][0];
      await fake.repo.putWorkflow({ ...(await fake.repo.getWorkflow(run.id))!, status: 'RUNNING' });
      await fake.repo.kv.put({ pk: `WF#${run.id}`, sk: `TASK#${task.name}`, ...task, phase: 'RUNNING' });
      pods[cluster] = [{ metadata: { name: `pod-${run.backendId}`, uid: `pod-uid-${run.backendId}`, labels: {
        ...job.metadata.labels, 'app.kubernetes.io/managed-by': 'physical-ai-dashboard',
      } }, spec: { containers: [{ name: 'main', image: 'test', ports: [{ name: 'pai-files', containerPort: 8077 }] }], nodeName: `node-${run.backendId}` },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'main', ready: true, restartCount: 0 }] } }];
      sessions.push(await createManagedSession({ kind: 'port-forward', workflowId: run.id, taskName: 'train', portName: 'pai-files' }, principal, projects[index]));
    }
    expect(sessions.map(s => s.backendId)).toEqual(['alpha', 'beta']);
    expect((await listSessionsWithStatus(principal)).map(s => s.status)).toEqual(['READY', 'READY']);
    const transport = createKubernetesTransport();
    const streams = await Promise.all(sessions.map(s => transport.connect(s as import('../gateway/types').GatewaySession, new AbortController().signal)));
    expect(fake.sockets.map(s => new URL(s.url).hostname).sort()).toEqual(['eks-alpha.eks.test', 'eks-beta.eks.test']);
    expect(fake.sockets.map(s => s.headers.authorization).sort()).toEqual(['Bearer token:us-east-1:eks-alpha', 'Bearer token:us-east-1:eks-beta']);
    for (const stream of streams) stream.destroy();
    const one = sessions[0] as import('../gateway/types').GatewaySession;
    expect(sessionBinding(one)).not.toBe(sessionBinding({ ...one, backendId: 'beta' }));
    await deleteSession(sessions[0].id, principal);
    expect(jobs['eks-alpha'].size).toBe(1); // attached sessions never delete training jobs
  });

  it('hydrates a cross-backend input only from home archive VersionIds and signs runtime claims with its destination backend', async () => {
    const checksum = createHash('sha256').update('weights').digest('base64');
    const prefix = 'projects/alpha/datasets/imported/versions/v1/';
    const manifest = JSON.stringify({ schemaVersion: 1, identity: 'imported-from-default', source: { bucket: 'data-home', prefix: 'checkpoints/source/' },
      objects: [{ path: 'model.pt', key: `${prefix}model.pt`, versionId: 'immutable-v1', bytes: 7, checksumSHA256: checksum }] });
    await fake.repo.kv.put({ pk: 'DS#imported', sk: 'META', name: 'imported', projectId: 'alpha', latestVersion: 1 });
    await fake.repo.putVersion({ dataset: 'imported', version: 1, projectId: 'alpha', state: 'READY', uri: `s3://home-archive/${prefix}`,
      manifestHash: createHash('sha256').update(manifest).digest('hex'), manifestUri: `s3://home-archive/${prefix}manifest.json`, createdAt: new Date().toISOString(), createdBy: 'alice', tags: [] });
    const wf = await submitted(projects[0], yaml + '      inputs: [{dataset: {name: imported, version: 1}}]\n');
    await reconcileWorkflow(wf, productionControllerDeps());
    const current = (await fake.repo.getWorkflow(wf.id))!, task = (await fake.repo.listTasks(wf.id))[0];
    const readCalls: string[][] = [];
    const forbidden = async () => { throw new Error('Input hydration never writes to storage'); };
    const storage: ObjectStorage = { presignPut: forbidden, writeManifest: forbidden,
      readManifest: async (bucket, key) => { readCalls.push([bucket, key]); return { body: manifest, versionId: 'manifest-v1' }; },
      head: async (bucket, key, version) => { readCalls.push([bucket, key, version!]); return { size: 7, versionId: 'immutable-v1', checksumSHA256: checksum, checksumType: 'FULL_OBJECT' }; },
      presignGet: async (bucket, key, version) => { readCalls.push([bucket, key, version]); return 'https://signed.test/pinned-input'; },
    };
    const broker = new RuntimeBroker({ repo: fake.repo, now: () => new Date(), signingKey: process.env.RUNTIME_SIGNING_KEY!, apiUrl: 'http://home-runtime.internal', artifactBucket: 'home-archive', storage });
    const env = broker.environment(current, current.spec.workflow.tasks[0], task.attemptEpoch!, task.attempts);
    expect(env.PAI_RUNTIME_BACKEND_ID).toBe('alpha');
    const auth = await broker.authenticate(env.PAI_RUNTIME_TOKEN);
    expect(auth.claims.backendId).toBe('alpha');
    const plan = await broker.inputs(env.PAI_RUNTIME_TOKEN);
    expect(plan.inputs[0].destination).toBe('/fsx/datasets/projects/alpha/imported/v1');
    expect(plan.inputs[0].files[0].versionId).toBe('immutable-v1');
    expect(readCalls.every(c => c[0] === 'home-archive')).toBe(true);
    await fake.repo.putWorkflow({ ...current, backendId: 'beta' });
    await expect(broker.authenticate(env.PAI_RUNTIME_TOKEN)).rejects.toThrow();
  });
});
