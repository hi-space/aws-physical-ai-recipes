import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ role: 'viewer', projectRole: 'viewer' }));
vi.mock('@/lib/api-client', () => ({
  api: vi.fn(),
  useMe: () => ({ data: { role: state.role, subject: 'viewer', project: { id: 'a', name: 'Project A', role: state.projectRole } } }),
  useApi: (path: string | null) => ({ refetch: vi.fn(), data: path?.startsWith('/api/builds/sources') ? {
    projectId: 'a', targets: [{ id: 'a', sourceType: 'S3', codeBuildProjectName: 'source-a' }],
    sources: [{ id: 'src-' + 'a'.repeat(32), name: 'Local snapshot', sourceType: 'S3', current: true,
      snapshot: { versionId: 'version1', sha256: 'a'.repeat(64) }, serviceRoleArn: 'PRIVATE_ROLE_SHOULD_NOT_RENDER' }],
  } : path?.startsWith('/api/builds/runs') ? { items: [] } : path === '/api/builds' ? [{ name: 'UNRELATED_OPERATIONS' }] : undefined }),
}));
import { BuildsPage } from './BuildsPage';
it('viewers see project source metadata without mutation controls or privileged Operations jobs', () => {
  state.role = 'viewer'; state.projectRole = 'viewer';
  const html = renderToStaticMarkup(React.createElement(BuildsPage));
  expect(html).toContain('Local snapshot');
  expect(html).not.toContain('출처 등록</button>');
  expect(html).not.toContain('이미지 빌드 시작</button>');
  expect(html).not.toContain('UNRELATED_OPERATIONS');
  expect(html).not.toContain('PRIVATE_ROLE_SHOULD_NOT_RENDER');
});
it('project administrators can register sources without gaining platform Operations controls', () => {
  state.role = 'researcher'; state.projectRole = 'project-admin';
  const html = renderToStaticMarkup(React.createElement(BuildsPage));
  expect(html).toContain('출처 등록');
  expect(html).toContain('이미지 빌드 시작');
  expect(html).not.toContain('UNRELATED_OPERATIONS');
  expect(html).toContain('이미지 프로필 승인');
});
