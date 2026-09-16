import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ admin: false }));
vi.mock('@/lib/api-client', () => ({
  api: vi.fn(),
  useApi: (path: string | null) => ({ data: path === '/api/image-profiles' ? { project: { id: 'a', name: 'Robot research' }, profiles: [], capabilities: { canApprove: state.admin, canSeed: state.admin } } : undefined, isLoading: false, refetch: vi.fn() }),
}));
import { ImageProfilesPage } from './ImageProfilesPage';
it('shows honest inspection boundaries and no administrator actions to a researcher', () => {
  state.admin = false;
  const html = renderToStaticMarkup(React.createElement(ImageProfilesPage));
  expect(html).toContain('Robot research');
  expect(html).toContain('실행 보장 아님');
  expect(html).toContain('등록된 이미지가 없습니다.');
  expect(html).toContain('미러링이 필요합니다.');
  expect(html).not.toContain('검사하고 승인 버전 저장');
  expect(html).not.toContain('배포 이미지 후보 검사');
});
it('distinguishes administrator-declared requirements from automatic proof', () => {
  state.admin = true;
  const html = renderToStaticMarkup(React.createElement(ImageProfilesPage));
  expect(html).toContain('관리자 선언입니다.');
  expect(html).toContain('검사하고 승인 버전 저장');
  expect(html).toContain('배포 이미지 후보 검사');
  expect(html).toContain('GPU당 최소 VRAM');
});
