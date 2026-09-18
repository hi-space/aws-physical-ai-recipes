import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiQueryOptions } from '@/lib/api-client';
import { OverviewPage } from './OverviewPage';

const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function overviewData() {
  return {
    features: { eks: true, slurm: false, amp: true, mlflow: true, pipeline: true, dcv: true, fsx: true },
    clusters: [],
    nodes: { total: 2, ready: 2, gpuCapacity: 2, gpuAllocatable: 2, gpuUtilAvg: 0, error: undefined as string | undefined },
    workflows: {
      total: 2, byStatus: { SUCCEEDED: 2 },
      recent: [
        { id: 'one', name: 'run-one', status: 'SUCCEEDED', owner: 'researcher', taskCount: 3, succeededCount: 2, createdAt: '2026-09-16T00:00:00Z' },
        { id: 'two', name: 'run-two', status: 'SUCCEEDED', owner: 'researcher', taskCount: 4, succeededCount: 4, createdAt: '2026-09-16T00:00:00Z' },
      ],
    },
    queues: { clusterQueues: 1, pendingWorkloads: 0, admitted: 0 },
    recentEvents: [],
    cost: {
      total: 76000, byService: [{ service: 'Amazon SageMaker', amount: 76000 }],
      daily: [{ date: '2026-09-14', amount: 36000 }, { date: '2026-09-15', amount: 40000 }],
    },
    controller: { running: true, leased: true, ticks: 1, holder: 'test' },
    errors: [] as string[],
  };
}
function makeClient(role = 'researcher', data?: ReturnType<typeof overviewData>) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  client.setQueryData(['api', '/api/me'], { role });
  if (data) client.setQueryData(['api', '/api/overview'], data);
  // Fixture for the architecture map (fetched separately by the component)
  client.setQueryData(['api', '/api/architecture'], {
    fetchedAt: '2026-09-18T12:00:00Z', region: 'us-east-1', accountId: '123456789012',
    components: [
      { id: 'data-bucket', layer: 'data', service: 'Amazon S3', resource: 'data-bucket', evidence: 'describe', api: 'S3 HeadBucket', tone: 'ok' },
      { id: 'hyperpod-eks', layer: 'compute', service: 'Amazon SageMaker HyperPod', resource: 'hyperpod-cluster', evidence: 'describe', api: 'SageMaker DescribeCluster', status: 'InService', tone: 'ok', facts: [{ key: 'instanceGroups', value: 2 }, { key: 'nodeRecovery', value: 'Automatic' }], console: { kind: 'hyperpod-cluster', name: 'hyperpod-cluster' } },
      { id: 'amp', layer: 'compute', service: 'Amazon Managed Service for Prometheus', resource: 'ws-1', evidence: 'config', tone: 'unknown' },
      { id: 'eks', layer: 'compute', service: 'Amazon EKS', resource: 'eks-a', evidence: 'describe', api: 'EKS DescribeCluster', tone: 'unknown', error: 'AccessDeniedException' },
    ],
  });
  clients.push(client);
  return client;
}
function render(client: QueryClient) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(OverviewPage)));
}

describe('overview service DTO integration', () => {
  it('counts all returned workflows even when none are running', () => {
    const html = render(makeClient('researcher', overviewData()));
    expect(html).toMatch(/(?:Workflows|워크플로)<\/div><div[^>]*>2<\/div>/);
  });

  it('uses succeededCount for the recent workflow progress', () => {
    const html = render(makeClient('researcher', overviewData()));
    expect(html).toContain('2/3');
    expect(html).toContain('4/4');
  });

  it.each([0, 37.5])('renders the numeric GPU average %s without treating zero as missing', (value) => {
    const data = overviewData();
    data.nodes.gpuUtilAvg = value;
    expect(render(makeClient('researcher', data))).toContain(`평균 사용률 ${value}%`);
  });

  it.each(['researcher', 'viewer'])('hides account-wide cost from %s even if the payload contains it', (role) => {
    const html = render(makeClient(role, overviewData()));
    expect(html).not.toContain('$76,000.00');
    expect(html).not.toContain('AWS 계정 전체 비용');
    // Make sure cost service breakdown doesn't appear (the "cost by service" section specifically)
    expect(html).not.toMatch(/(?:Account-wide|계정 전체|cost by service|서비스별 계정)/);
  });

  it('labels admin cost as account-wide and converts daily amount objects for the chart', () => {
    const data = overviewData();
    data.features.eks = false;
    const html = render(makeClient('admin', data));
    expect(html).toContain('AWS 계정 전체 비용 (최근 30일)');
    expect(html).toContain('$76,000.00');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('NaN');
  });

  it('shows request errors instead of fabricated zero-count tiles', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'overview unavailable' }, { status: 503 }));
    const client = makeClient();
    await client.fetchQuery(apiQueryOptions('/api/overview', { retry: false })).catch(() => undefined);
    const html = render(client);
    expect(html).toContain('overview unavailable');
    expect(html).not.toContain('0/0');
    expect(html).not.toContain('No workflows yet');
  });

  it('shows partial service errors and does not present failed node lookup as healthy zero capacity', () => {
    const data = overviewData();
    data.errors = ['workflow inventory unavailable'];
    data.nodes = { total: 0, ready: 0, gpuCapacity: 0, gpuAllocatable: 0, gpuUtilAvg: 0, error: 'node inventory unavailable' };
    const html = render(makeClient('researcher', data));
    expect(html).toContain('workflow inventory unavailable');
    expect(html).toContain('node inventory unavailable');
    expect(html).not.toContain('0/0');
  });

  it('places researcher start links before the workflow summary', () => {
    const html = render(makeClient('researcher', overviewData()));
    const action = html.indexOf('href="/workflows/new"');
    const summary = html.search(/(?:Workflows|워크플로)<\/div>/);
    expect(action).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(action);
    expect(html).toContain('href="/datasets"');
    expect(html).toContain('href="/experiments"');
  });

  it('renders the architecture map: raw status, facts, identifier-only marker, describe errors, console link from the response region', () => {
    const html = render(makeClient('researcher', overviewData()));
    expect(html).toContain('이 배포의 AWS 아키텍처');
    expect(html).toContain('hyperpod-cluster');
    expect(html).toContain('InService');
    expect(html).toContain('인스턴스 그룹 2개');
    expect(html).toContain('노드 복구 Automatic');
    expect(html).toContain('배포 설정의 식별자');
    expect(html).toContain('AccessDeniedException');
    expect(html).toContain('https://us-east-1.console.aws.amazon.com/sagemaker/home?region=us-east-1#/cluster-management/hyperpod-cluster');
    expect(html).not.toContain('layer_simulation');
  });
});
