import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiQueryOptions } from '@/lib/api-client';
import { AccessPage } from './AccessPage';
const clients: QueryClient[] = [];
function makeClient() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } }); clients.push(client); return client; }
function render(client: QueryClient) { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AccessPage))); }
afterEach(() => { clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
it('offers private credential and scoped token forms only after the project APIs respond', () => {
  const client = makeClient();
  client.setQueryData(['api', '/api/credentials'], { projectId: 'team-a', credentials: [], capabilities: { canWrite: true, canShare: false, canRegisterLegacy: false } });
  client.setQueryData(['api', '/api/tokens'], { projectId: 'team-a', tokens: [], availableScopes: ['workflows:read'] });
  const html = render(client);
  expect(html).toContain('team-a'); expect(html).toContain('자격증명 등록'); expect(html).toContain('토큰 발급');
  expect(html).not.toContain('프로젝트에 공유'); expect(html).not.toContain('기존 워크숍 참조 등록');
  expect(html).toContain('type="password"'); expect(html).toContain('workflows:read');
});
it('shows unavailable APIs as errors and does not enable issuance forms', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'access API unavailable' }, { status: 404 }));
  const client = makeClient();
  await Promise.all(['/api/credentials', '/api/tokens'].map((path) => client.fetchQuery(apiQueryOptions(path, { retry: false })).catch(() => undefined)));
  const html = render(client);
  expect(html).toContain('access API unavailable');
  expect(html).not.toMatch(/<form/);
  expect(html).not.toContain('발급한 API 토큰이 없습니다.');
});
