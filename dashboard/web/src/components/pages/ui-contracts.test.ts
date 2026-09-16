import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PipelinesPage } from './PipelinesPage';
import { PipelineExecutionPage } from './PipelineExecutionPage';
import { EdgePage } from './EdgePage';
import { MetricsPage } from './MetricsPage';
import { DatasetDetailPage } from './DatasetDetailPage';

const navigation = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  navigation.search = '';
  vi.unstubAllGlobals();
});
function clientFor(role = 'researcher') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['api', '/api/me'], { role });
  clients.push(client);
  return client;
}
function render(client: QueryClient, component: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, component));
}

function renderDatasetVersion(state?: 'PENDING' | 'READY', finalizationError?: string) {
  const client = clientFor();
  client.setQueryData(['api', '/api/datasets/demo'], {
    dataset: { name: 'demo', owner: 'researcher', tags: [], latestVersion: 1 },
    versions: [{ dataset: 'demo', version: 1, uri: 's3://bucket/datasets/demo/v1/', tags: [], state, finalizationError }],
    lineage: { produced: [], consumers: [] },
  });
  client.setQueryData(['api', '/api/datasets/demo/versions/1?prefix=&token='], {
    bucket: 'bucket', prefix: 'datasets/demo/v1/', entries: [],
  });
  return render(client, createElement(DatasetDetailPage, { name: 'demo' }));
}

describe('page / API integration contracts', () => {
  it('shows pipeline submission to researchers, but not viewers', () => {
    for (const role of ['researcher', 'viewer']) {
      const client = clientFor(role);
      client.setQueryData(['api', '/api/pipelines'], {
        pipeline: { PipelineName: 'groot', PipelineStatus: 'Active', parameters: [] },
        executions: [],
      });
      const html = render(client, createElement(PipelinesPage));
      expect(html.includes('실행 시작')).toBe(role === 'researcher');
    }
  });

  it('requests pipeline execution detail using a single encoded ARN segment', () => {
    const client = clientFor();
    client.setQueryData(['api', '/api/pipelines/executions/arn%3Aaws%3Asagemaker%3Aus-east-1%3A123456789012%3Apipeline%2Fgroot%2Fexecution%2Fabc'], {
      execution: { PipelineExecutionDisplayName: '시험 실행', PipelineExecutionStatus: 'Executing' },
      steps: [], parameters: [],
    });
    const html = render(client, createElement(PipelineExecutionPage, {
      arn: 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot/execution/abc',
    }));
    expect(html).toContain('시험 실행');
  });

  it('binds a verified modelId to a registered edge target and prepares before sending', () => {
    const modelId = `mdl-${'a'.repeat(24)}`;
    const deviceId = `dev-${'b'.repeat(24)}`;
    navigation.search = `?model_id=${modelId}&modelPath=%2Ffsx%2Fcheckpoints%2Funtrusted-path`;
    const client = clientFor('admin');
    const model = {
      id: modelId, projectId: 'project-a', name: 'Registered checkpoint model',
      checkpoint: { path: 'final/model.zip', versionId: 'checkpoint-object-version' },
      qualityApproval: { approved: true },
    };
    const device = {
      id: deviceId, projectId: 'project-a', label: 'Registered project core',
      kind: 'core', targetName: 'registered-core', architecture: 'amd64', physical: false,
      members: [], revision: 1,
      profiles: [{ id: 'profile-reviewed', name: 'com.physicalai.inference', version: '2.3.4', purpose: 'inference', architecture: 'amd64' }],
    };
    client.setQueryData(['api', '/api/edge'], {
      projectId: 'project-a', devices: [device], models: [], operations: [], runs: [], leases: [],
      canWrite: true, canRegister: true,
    });
    // The selected ID must resolve through the project-scoped model endpoint,
    // even when it is not on the current models-list page.
    client.setQueryData(['api', `/api/models/${modelId}`], { model });
    client.setQueryData(['api', `/api/edge/devices/${deviceId}`], {
      device, benchmarks: [], observation: { coreStatus: 'HEALTHY', installed: [] },
    });
    const html = render(client, createElement(EdgePage));
    expect(html).toContain('Registered project core');
    expect(html).toMatch(new RegExp(`<option value="${modelId}"[^>]*selected`));
    expect(html).toContain('Registered checkpoint model');
    expect(html).toContain('checkpoint-object-version');
    expect(html).toContain('배포 계획 준비');
    expect(html).not.toContain('검토한 계획을 AWS에 전송');
    expect(html).toContain('이전 modelPath 링크는 배포에 사용하지 않습니다');
    expect(html).not.toContain('/fsx/checkpoints/untrusted-path');
    expect(html).not.toContain('/home/ubuntu/environment/models/GR00T-N1.6-3B');
  });

  it('lets a researcher create the first version of an empty dataset', () => {
    const client = clientFor();
    client.setQueryData(['api', '/api/datasets/new-dataset'], {
      dataset: { name: 'new-dataset', owner: 'researcher', tags: [], latestVersion: 0 },
      versions: [], lineage: { produced: [], consumers: [] },
    });
    expect(render(client, createElement(DatasetDetailPage, { name: 'new-dataset' }))).toContain('새 버전');
  });

  it('allows pending uploads and exposes explicit version finalization', () => {
    const html = renderDatasetVersion('PENDING');
    const fileInput = html.match(/<input\b[^>]*type="file"[^>]*>/)?.[0];
    expect(fileInput).toBeDefined();
    expect(fileInput).not.toContain('disabled');
    expect(html).toContain('PENDING');
    expect(html).toMatch(/<button\b[^>]*>검증 및 버전 확정<\/button>/);
  });

  it('disables uploads for ready versions and explains how to change committed contents', () => {
    const html = renderDatasetVersion('READY');
    expect(html.match(/<input\b[^>]*type="file"[^>]*>/)?.[0]).toContain('disabled');
    expect(html).toContain('READY');
    expect(html).toContain('내용을 바꾸려면 새 버전을 만드세요.');
    expect(html).toContain('확정된 메타데이터 조회');
  });

  it('disables uploads when the API has not supplied a pending state', () => {
    expect(renderDatasetVersion().match(/<input\b[^>]*type="file"[^>]*>/)?.[0]).toContain('disabled');
  });

  it('shows the worker finalization error while leaving the pending version retryable', () => {
    const html = renderDatasetVersion('PENDING', 'manifest checksum mismatch');
    expect(html).toContain('manifest checksum mismatch');
    const button = html.match(/<button\b[^>]*>검증 및 버전 확정<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it('sends all 14 metrics as POST requests within the 12-query server limit', async () => {
    const requests: { method?: string; queries: { id: string }[] }[] = [];
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
      requests.push({ method: init.method, queries: JSON.parse(init.body as string).queries });
      return Response.json({});
    });
    const client = clientFor('admin');
    render(client, createElement(MetricsPage));
    const queries = client.getQueryCache().findAll({ queryKey: ['api', '/api/metrics/query'] });
    await Promise.all(queries.map((query) => query.fetch()));
    expect(requests.length).toBe(2);
    expect(requests.every((request) => request.method === 'POST' && request.queries.length <= 12)).toBe(true);
    expect(new Set(requests.flatMap((request) => request.queries.map((query) => query.id))).size).toBe(14);
  });
});
