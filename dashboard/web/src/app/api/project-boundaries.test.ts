import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  queryInstant: vi.fn(),
  queryRange: vi.fn(),
  listClusterQueues: vi.fn(),
  listLocalQueues: vi.fn(),
  listResourceFlavors: vi.fn(),
  listPriorityClasses: vi.fn(),
  listWorkloads: vi.fn(),
  listS3: vi.fn(),
}));

vi.mock('@/server/aws/cognito', () => ({ currentUserAuthorization: mocks.currentUser }));
vi.mock('@/server/aws/amp', async (original) => ({
  ...await original<typeof import('@/server/aws/amp')>(),
  queryInstant: mocks.queryInstant,
  queryRange: mocks.queryRange,
}));
vi.mock('@/server/k8s/kueue', async (original) => ({
  ...await original<typeof import('@/server/k8s/kueue')>(),
  listClusterQueues: mocks.listClusterQueues,
  listLocalQueues: mocks.listLocalQueues,
  listResourceFlavors: mocks.listResourceFlavors,
  listPriorityClasses: mocks.listPriorityClasses,
  listWorkloads: mocks.listWorkloads,
}));
vi.mock('@/server/aws/s3', async (original) => ({
  ...await original<typeof import('@/server/aws/s3')>(),
  list: mocks.listS3,
}));

import proxy from '@/proxy';
import { createApiToken } from '@/server/auth/api-tokens';
import { canReadResource, projectItem, type Project } from '@/server/auth/projects';
import { projectFixture, putProject } from '@/server/auth/session.test-helpers';
import { resetConfigForTests } from '@/server/config';
import { MemoryKV } from '@/server/store/dynamo';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { POST as metrics } from './metrics/query/route';
import { GET as queues } from './queues/route';
import { GET as datasets } from './datasets/route';
import { GET as storage } from './s3/route';

const origin = 'https://project-boundaries.example';
const project: Project = projectFixture('a');
const principal = { user: 'alice', subject: 'sub-a', email: '', role: 'researcher' as const, groups: ['researchers', 'proj-a'] };
let repo: Repo;
let token: string;

function browserRequest(path: string, role = 'researcher') {
  return new NextRequest(origin + path, { headers: {
    'x-pai-user': principal.user,
    'x-pai-subject': principal.subject,
    'x-pai-role': role,
    'x-pai-auth-method': 'alb',
    'x-pai-project': project.id,
    'x-pai-groups': 'researchers,proj-a',
  } });
}

/** Exercise token verification and the proxy's forwarded headers, not forged trusted identity. */
async function tokenRequest(path: string, method = 'GET', body?: unknown) {
  const request = new NextRequest(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-pai-user': 'mallory',
      'x-pai-role': 'admin',
      'x-pai-project': 'b',
      'x-pai-token-project': 'b',
      cookie: 'pai-project=b',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await proxy(request);
  const destination = response.headers.get('x-middleware-rewrite');
  expect(destination).toBeTruthy();
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-middleware-request-')) headers.set(name.slice('x-middleware-request-'.length), value);
  }
  expect(headers.get('x-pai-user')).toBe(principal.user);
  expect(headers.get('x-pai-role')).toBe('researcher');
  expect(headers.get('x-pai-project')).toBe('a');
  expect(headers.get('x-pai-token-project')).toBe('a');
  expect(headers.get('x-pai-groups')).toContain('proj-a');
  expect(headers.has('authorization')).toBe(false);
  return new NextRequest(destination!, {
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_MODE', 'dev');
  vi.stubEnv('DASHBOARD_ORIGIN', origin);
  vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET', 'review-artifacts');
  resetConfigForTests();
  repo = new Repo(new MemoryKV());
  setRepoForTests(repo);
  await repo.kv.put(projectItem(project));
  await putProject(repo.kv, 'b');
  mocks.currentUser.mockResolvedValue({
    username: principal.user, subject: principal.subject, enabled: true, groups: ['researchers', 'proj-a'], email: '',
  });
  token = (await createApiToken(principal, project, {
    name: 'boundary-fixture', scopes: ['metrics:read', 'datasets:read'], expiresInDays: 1,
  })).token;
  mocks.queryInstant.mockResolvedValue([{ metric: { namespace: project.namespace, pod: 'own-pod' }, value: [1, 2] }]);
  mocks.queryRange.mockResolvedValue([]);
  mocks.listLocalQueues.mockResolvedValue([
    { metadata: { name: 'hyperpod-ns-a-localqueue', namespace: project.namespace }, spec: { clusterQueue: 'cq-a' } },
    { metadata: { name: 'hyperpod-ns-b-localqueue', namespace: 'hyperpod-ns-b' }, spec: { clusterQueue: 'cq-b' } },
    { metadata: { name: 'other-q', namespace: project.namespace }, spec: { clusterQueue: 'other-cq' } },
  ]);
  mocks.listClusterQueues.mockResolvedValue(['a', 'b'].map((id) => ({
    metadata: { name: `cq-${id}` },
    spec: { resourceGroups: [{ flavors: [{ name: `flavor-${id}`, resources: [] }] }] },
  })));
  mocks.listResourceFlavors.mockResolvedValue(['a', 'b'].map((id) => ({
    metadata: { name: `flavor-${id}` }, spec: { nodeLabels: { pool: id } },
  })));
  mocks.listPriorityClasses.mockResolvedValue([]);
  mocks.listWorkloads.mockResolvedValue([
    ...['a', 'b'].map((id) => ({
      metadata: { name: `work-${id}`, namespace: `hyperpod-ns-${id}` },
      spec: { queueName: `hyperpod-ns-${id}-localqueue`, podSets: [{
        name: 'main', count: 1,
        template: { spec: { containers: [{ name: 'main', env: [{ name: `PRIVATE_${id}`, value: 'fixture' }] }] } },
      }] },
    })),
    { metadata: { name: 'wrong-queue', namespace: project.namespace }, spec: { queueName: 'other-q' } },
  ]);
  mocks.listS3.mockImplementation(async (bucket: string, prefix: string) => ({
    bucket, prefix,
    entries: bucket === 'review-artifacts' && prefix === 'projects/a/'
      ? [{ key: 'projects/a/datasets/data/versions/v1/data.bin', name: 'data.bin', isPrefix: false, size: 3 }]
      : [],
  }));
});

describe('project metrics through versioned token authentication', () => {
  it('rejects another namespace before querying metrics', async () => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'q', metric: 'pod_cpu', params: { namespace: 'hyperpod-ns-b' } }],
    }));
    expect(response.status).toBe(403);
    expect(mocks.queryInstant).not.toHaveBeenCalled();
    expect(mocks.queryRange).not.toHaveBeenCalled();
  });

  it('supplies the token project namespace when the caller omits it', async () => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'q', metric: 'pod_cpu' }],
    }));
    expect(response.status).toBe(200);
    expect(mocks.queryInstant).toHaveBeenCalledWith(expect.stringContaining('namespace="hyperpod-ns-a"'));
    expect((await response.json()).q.instant[0].metric.namespace).toBe(project.namespace);
  });

  it.each(['gpu_util', 'gpu_mem_used'])('keeps %s scoped when translating node-oriented UI requests', async (metric) => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'q', metric, params: { node: '.*' } }],
    }));
    expect(response.status).toBe(200);
    expect(mocks.queryInstant).toHaveBeenCalledWith(expect.stringContaining('namespace="hyperpod-ns-a"'));
  });

  it.each(['node_cpu', 'gpu_power', 'gpu_allocatable'])('rejects unscopable %s for project tokens', async (metric) => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'q', metric }],
    }));
    expect(response.status).toBe(403);
    expect(mocks.queryInstant).not.toHaveBeenCalled();
  });

  it('validates the entire batch before issuing any metrics requests', async () => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'own', metric: 'pod_cpu' }, { id: 'forbidden', metric: 'node_cpu' }],
    }));
    expect(response.status).toBe(403);
    expect(mocks.queryInstant).not.toHaveBeenCalled();
    expect(mocks.queryRange).not.toHaveBeenCalled();
  });

  it('uses the registered LocalQueue mapping instead of a caller-selected ClusterQueue', async () => {
    const response = await metrics(await tokenRequest('metrics/query', 'POST', {
      queries: [{ id: 'q', metric: 'kueue_usage_gpu', params: { cluster_queue: 'cq-b' } }],
    }));
    expect(response.status).toBe(200);
    const promql = mocks.queryInstant.mock.calls[0][0] as string;
    expect(promql).toContain('cluster_queue="cq-a"');
    expect(promql).not.toContain('cq-b');
  });
});

describe('project queue inventory', () => {
  it('filters namespaces, queues, ClusterQueues and flavors, and strips embedded Pod templates', async () => {
    const response = await queues(browserRequest('/api/queues'));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(mocks.listWorkloads).toHaveBeenCalledWith(project.namespace);
    expect(result.workloads.map((item: { name: string }) => item.name)).toEqual(['work-a']);
    expect(result.localQueues.map((item: { name: string }) => item.name)).toEqual(['hyperpod-ns-a-localqueue']);
    expect(result.clusterQueues.map((item: { name: string }) => item.name)).toEqual(['cq-a']);
    expect(result.flavors.map((item: { name: string }) => item.name)).toEqual(['flavor-a']);
    expect(result.workloads[0].podSets).toEqual([{ name: 'main', count: 1 }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
});

describe('dataset list and detail authorization agree', () => {
  beforeEach(async () => {
    for (const [name, projectId] of [['owned-a', 'a'], ['owned-b', 'b'], ['legacy-private', undefined]] as const) {
      await repo.putDataset({
        name, projectId, owner: principal.user, ownerSubject: principal.subject,
        description: `${name} fixture`, latestVersion: 0, tags: [], createdAt: 'x', updatedAt: 'x',
      });
    }
  });

  it('excludes owned legacy and foreign-project records from a project-bound token list', async () => {
    const response = await datasets(await tokenRequest('datasets'));
    expect(response.status).toBe(200);
    expect((await response.json()).map((item: { name: string }) => item.name)).toEqual(['owned-a']);
    expect(await canReadResource(
      { ...principal, tokenProjectId: 'a' }, (await repo.getDataset('legacy-private'))!, repo,
    )).toBe(false);
  });

  it('scopes the selected project and preserves an explicit browser view of owned legacy records', async () => {
    const response = await datasets(browserRequest('/api/datasets'));
    expect(response.status).toBe(200);
    expect((await response.json()).map((item: { name: string }) => item.name).sort()).toEqual(['owned-a']);
    const legacy = await datasets(browserRequest('/api/datasets?legacy=1'));
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).map((item: { name: string }) => item.name)).toEqual(['legacy-private']);
  });
});

describe('S3 project browse roots', () => {
  it('finds project artifacts when the artifact-bucket request starts with an empty prefix', async () => {
    const response = await storage(browserRequest('/api/s3?bucket=review-artifacts&prefix='));
    expect(response.status).toBe(200);
    expect(mocks.listS3).toHaveBeenCalledWith('review-artifacts', 'projects/a/', undefined);
    expect(await response.json()).toMatchObject({
      rootPrefix: 'projects/a/', prefix: 'projects/a/',
      entries: [{ key: 'projects/a/datasets/data/versions/v1/data.bin' }],
    });
  });

  it('retains the dataset mirror root for a non-artifact bucket', async () => {
    const response = await storage(browserRequest('/api/s3?bucket=review-mirror'));
    expect(response.status).toBe(200);
    expect(mocks.listS3).toHaveBeenCalledWith('review-mirror', 'datasets/projects/a/', undefined);
    expect((await response.json()).rootPrefix).toBe('datasets/projects/a/');
  });

  it('rejects a foreign project prefix before listing S3', async () => {
    const response = await storage(browserRequest('/api/s3?bucket=review-artifacts&prefix=projects%2Fb%2F'));
    expect(response.status).toBe(403);
    expect(mocks.listS3).not.toHaveBeenCalled();
  });
});
