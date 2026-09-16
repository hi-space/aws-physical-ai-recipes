import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ admin: false }));
vi.mock('@/lib/api-client', () => ({
  api: vi.fn(),
  useApi: (path: string | null) => ({ data: path === '/api/webhooks' ? { project: { id: 'a', name: 'Project A' },
    hooks: [{ id: 'wh-fixture', name: 'Events', state: 'ACTIVE', enabled: true, statuses: ['FAILED'], endpointUrl: 'https://private.example/secret-path', secret: 'PRIVATE_FIXTURE' }],
    canManage: state.admin } : undefined, refetch: vi.fn(), isLoading: false }),
}));
import { WebhooksPage } from './WebhooksPage';
it('shows safe metadata only to viewers, even if a malformed fixture supplies secret fields', () => {
  state.admin = false;
  const html = renderToStaticMarkup(React.createElement(WebhooksPage));
  expect(html).toContain('Project A');
  expect(html).toContain('Events');
  expect(html).not.toContain('secret-path');
  expect(html).not.toContain('PRIVATE_FIXTURE');
  expect(html).not.toContain('구독 등록</button>');
});
it('offers project-admin configuration with hidden key input and honest delivery semantics', () => {
  state.admin = true;
  const html = renderToStaticMarkup(React.createElement(WebhooksPage));
  expect(html).toContain('type="password"');
  expect(html).toContain('중복 수신 가능');
  expect(html).toContain('테스트 메시지를 보내지 않습니다.');
});
