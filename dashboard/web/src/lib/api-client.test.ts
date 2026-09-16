import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { api, apiQueryOptions, ApiError } from './api-client';

afterEach(() => vi.unstubAllGlobals());

describe('API request contract', () => {
  it('sends POST query bodies and preserves Headers instances', async () => {
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => Response.json({
      method: init.method,
      body: JSON.parse(init.body as string),
      project: new Headers(init.headers).get('x-project'),
    }));
    const client = new QueryClient();
    const result = await client.fetchQuery(apiQueryOptions('/api/metrics/query', {
      init: { method: 'POST', json: { queries: ['gpu_util'] }, headers: new Headers({ 'x-project': 'team-a' }) },
    }));
    expect(result).toEqual({ method: 'POST', body: { queries: ['gpu_util'] }, project: 'team-a' });
    client.clear();
  });

  it('separates request bodies and headers while reusing equivalent JSON queries', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => Response.json({
      request: ++requests, ...JSON.parse(init.body as string),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const read = (json: unknown, project = 'a') => client.fetchQuery(apiQueryOptions('/api/metrics/query', {
      init: { method: 'POST', json, headers: { 'x-project': project } },
    }));
    expect(await read({ node: 'gpu-1', range: '1h' })).toMatchObject({ request: 1 });
    expect(await read({ range: '1h', node: 'gpu-1' })).toMatchObject({ request: 1 });
    expect(await read({ node: 'gpu-2', range: '1h' })).toMatchObject({ request: 2 });
    expect(await read({ node: 'gpu-2', range: '1h' }, 'b')).toMatchObject({ request: 3 });
    await client.invalidateQueries({ queryKey: ['api', '/api/metrics/query'] });
    expect(await read({ node: 'gpu-1', range: '1h' })).toMatchObject({ request: 4 });
    client.clear();
  });

  it.each(['query', 'caller'] as const)('propagates %s cancellation to fetch', async (source) => {
    let transportSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal('fetch', (_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      transportSignal = init.signal!;
      transportSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      started();
    }));
    const client = new QueryClient();
    const caller = new AbortController();
    const request = client.fetchQuery(apiQueryOptions('/api/metrics/query', {
      init: { signal: caller.signal }, retry: false,
    })).catch((error: unknown) => error);
    await ready;
    if (source === 'query') await client.cancelQueries({ queryKey: ['api', '/api/metrics/query'] });
    else caller.abort();
    await request;
    expect(transportSignal?.aborted).toBe(true);
    client.clear();
  });

  it('rejects failed mutations with the server message and error details', async () => {
    vi.stubGlobal('fetch', async () => Response.json(
      { error: '배포 요청 실패', code: 'conflict', details: { deploymentId: 'd1' } }, { status: 409 },
    ));
    await expect(api('/api/edge/deployments', { method: 'POST', json: {} }))
      .rejects.toMatchObject({ status: 409, message: '배포 요청 실패', code: 'conflict', details: { deploymentId: 'd1' } });
    await expect(api('/api/edge/deployments')).rejects.toBeInstanceOf(ApiError);
  });
});
