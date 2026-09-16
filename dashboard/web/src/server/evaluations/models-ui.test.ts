import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ responses: new Map<string, unknown>(), role: 'researcher' }));
vi.mock('@/lib/api-client', () => ({
  api: vi.fn(),
  useMe: () => ({ data: { role: state.role } }),
  useApi: (path: string | null) => ({ data: path ? state.responses.get(path) : undefined, isLoading: false, error: undefined, refetch: async () => undefined }),
}));
import { ModelsPage } from '../../components/pages/ModelsPage';
import { ModelsService } from '../services/models';
import { alice, fixture } from './test-fixtures';
beforeEach(() => { state.responses.clear(); state.role = 'researcher'; });
describe('model quality UI', () => {
  it('shows an honest empty state without legacy AWS sources for researchers', () => {
    state.responses.set('/api/models', { models: [], outputs: [], canWrite: true });
    const html = renderToStaticMarkup(createElement(ModelsPage));
    expect(html).toContain('등록된 모델이 없습니다');
    expect(html).toContain('학습 출력에서 등록');
    expect(html).not.toContain('기존 AWS 모델 · 관리자');
    expect(html).not.toContain('100.0%');
  });
  it('renders actual ingested results and keeps quality approval an explicit disabled action before a gate check', async () => {
    const data = await fixture({ successes: 16 });
    const service = new ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive' });
    const model = await service.register(alice, 'a', { name: 'Real source candidate', dataset: 'weights-run', version: 1, checkpointPath: 'final/model.zip' });
    await service.ingest(alice, 'a', { modelId: model.id, dataset: 'evaluation-run', version: 1 });
    state.responses.set('/api/models', await service.list(alice, 'a'));
    state.responses.set(`/api/models/${model.id}`, await service.get(alice, 'a', model.id));
    const html = renderToStaticMarkup(createElement(ModelsPage));
    expect(html).toContain('16 / 20');
    expect(html).toContain('80.0%');
    expect(html).toContain('품질 미승인');
    expect(html).toContain('VersionId');
    expect(html).toContain('SageMaker Model Registry를 변경하지 않습니다');
    expect(html).toContain('template=mujoco-render');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>애플리케이션 품질 승인<\/button>/);
    expect(html).toContain('value="20"');
    expect(html).toContain('value="80"');
    expect(html).toContain('value="100"');
  });
  it('does not offer mutation actions to a project viewer', () => {
    state.responses.set('/api/models', { models: [], outputs: [], canWrite: false });
    const html = renderToStaticMarkup(createElement(ModelsPage));
    expect(html).toContain('조회만 할 수 있습니다');
    expect(html).not.toContain('출력에서 모델 등록');
    expect(html).not.toContain('학습 출력에서 등록');
  });
  it('makes the legacy browser explicitly admin-only', () => {
    state.role = 'admin';
    state.responses.set('/api/models', { models: [], outputs: [], canWrite: true });
    expect(renderToStaticMarkup(createElement(ModelsPage))).toContain('기존 AWS 모델 · 관리자');
  });
});
