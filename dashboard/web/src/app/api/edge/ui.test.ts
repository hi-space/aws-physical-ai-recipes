import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ query: '', responses: new Map<string, unknown>(), requested: [] as (string | null)[] }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('@/lib/api-client', () => ({
  api: vi.fn(),
  useApi: (path: string | null) => { state.requested.push(path); return { data: path ? state.responses.get(path) : undefined, isLoading: false, error: undefined, refetch: async () => undefined }; },
}));
import { EdgePage } from '@/components/pages/EdgePage';
import { fixture, registration, alice, reader } from './fixtures';
beforeEach(() => { state.query = ''; state.responses.clear(); state.requested = []; });
describe('edge UI truth and scope', () => {
  it('shows project registration rather than global AWS devices or an assumed deployment target', () => {
    state.responses.set('/api/edge', { devices: [], models: [], operations: [], runs: [], leases: [], canWrite: true, canRegister: true });
    const html = renderToStaticMarkup(createElement(EdgePage));
    expect(html).toContain('프로젝트에 등록된 디바이스가 없습니다');
    expect(html).toContain('프로젝트 디바이스 등록');
    expect(html).not.toContain('GR00T-N1.6-3B');
  });
  it('ignores legacy model paths and validates the actual modelId query binding', async () => {
    const data = await fixture();
    const d = await data.service.register(alice, 'a', registration());
    state.query = `modelId=${data.model.id}&modelPath=/arbitrary/device/path`;
    state.responses.set('/api/edge', await data.service.list(alice, 'a'));
    state.responses.set(`/api/edge/devices/${d.id}`, await data.service.get(alice, 'a', d.id));
    state.responses.set(`/api/models/${data.model.id}`, await data.models.get(alice, 'a', data.model.id));
    const html = renderToStaticMarkup(createElement(EdgePage));
    expect(state.requested).toContain(`/api/models/${data.model.id}`);
    expect(html).toContain('이전 modelPath 링크는 배포에 사용하지 않습니다');
    expect(html).not.toContain('/arbitrary/device/path');
    expect(html).toContain('2.3.4');
    expect(html).not.toContain('1.0.0');
    expect(html).toContain('배포 계획 준비');
  });
  it('does not offer mutation controls to project viewers', async () => {
    const data = await fixture();
    state.responses.set('/api/edge', await data.service.list(reader, 'a'));
    const html = renderToStaticMarkup(createElement(EdgePage));
    expect(html).toContain('조회만 할 수 있습니다');
    expect(html).not.toContain('프로젝트 디바이스 등록</button>');
    expect(html).not.toContain('AWS에 전송');
  });
  it('does not look up malformed model IDs', () => {
    state.query = 'modelId=../foreign-model';
    state.responses.set('/api/edge', { devices: [], models: [], operations: [], runs: [], leases: [], canWrite: false, canRegister: false });
    expect(renderToStaticMarkup(createElement(EdgePage))).toContain('modelId 형식이 올바르지 않습니다');
    expect(state.requested.some(path => path?.includes('/api/models/'))).toBe(false);
  });
});
