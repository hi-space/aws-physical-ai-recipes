import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as listModels, POST as registerModel } from '../../app/api/models/route';
import { GET as getModel } from '../../app/api/models/[id]/route';
import { GET as getOutput } from '../../app/api/models/outputs/[dataset]/[version]/route';
import { GET as legacyModels } from '../../app/api/models/legacy/route';
import { POST as ingest } from '../../app/api/evaluations/route';
import { GET as getEvaluation } from '../../app/api/evaluations/[id]/route';
import { GET as getArtifact } from '../../app/api/evaluations/[id]/artifact/route';
import { POST as promote } from '../../app/api/models/[id]/promotion/route';
import * as services from '../services/models';
import { setRepoForTests } from '../store/repo';
import { resetConfigForTests } from '../config';
import { alice, bob, reader, fixture, admin } from './test-fixtures';
import type { Session } from '../auth/session';

let data: Awaited<ReturnType<typeof fixture>>;
let service: services.ModelsService;
const body = { name: 'Model through API', dataset: 'weights-run', version: 1, checkpointPath: 'final/model.zip' };
function request(path: string, session: Session = alice, method = 'GET', payload?: unknown, project = 'a', origin = 'http://localhost') {
  return new NextRequest(`http://localhost${path}`, { method, headers: {
    'x-pai-user': session.user, 'x-pai-subject': session.subject!, 'x-pai-role': session.role,
    'x-pai-groups': (session.groups ?? []).join(','),
    'x-pai-project': project, origin, 'content-type': 'application/json',
  }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv('DASHBOARD_ORIGIN', 'http://localhost'); resetConfigForTests();
  data = await fixture(); setRepoForTests(data.repo);
  service = new services.ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive',
    legacy: async () => [{ name: 'SageMaker registry', status: 'error', error: 'Registry test error' }] });
  vi.spyOn(services, 'modelsService').mockReturnValue(service);
});
describe('model/evaluation HTTP project boundaries', () => {
  it('registers a published checkpoint through the guarded route and returns project-only sources', async () => {
    const response = await registerModel(request('/api/models', alice, 'POST', body));
    expect(response.status).toBe(200);
    const model = await response.json();
    expect(model.projectId).toBe('a');
    const listing = await (await listModels(request('/api/models'))).json();
    expect(listing.models.map((m: { id: string }) => m.id)).toEqual([model.id]);
    expect(listing).not.toHaveProperty('sagemakerModels');
    expect(listing).not.toHaveProperty('modelPackages');
    const files = await getOutput(request('/api/models/outputs/weights-run/1'), { params: Promise.resolve({ dataset: 'weights-run', version: '1' }) });
    expect((await files.json()).files.find((f: { path: string }) => f.path === 'final/model.zip').versionId).toBe('object-v1');
  });
  it('enforces Origin, platform role and project role before reading any checkpoint object', async () => {
    expect((await registerModel(request('/api/models', alice, 'POST', body, 'a', 'https://evil.example'))).status).toBe(403);
    expect((await registerModel(request('/api/models', { ...alice, role: 'viewer' }, 'POST', body))).status).toBe(403);
    expect((await registerModel(request('/api/models', reader, 'POST', body))).status).toBe(403);
    expect((await registerModel(request('/api/models', bob, 'POST', body))).status).toBe(403);
    expect(data.objects.heads).toEqual([]);
  });
  it('does not leak model IDs, output files or legacy AWS sources across projects', async () => {
    const model = await service.register(alice, 'a', body);
    expect((await getModel(request(`/api/models/${model.id}`, bob, 'GET', undefined, 'b'), { params: Promise.resolve({ id: model.id }) })).status).toBe(404);
    expect((await getOutput(request('/api/models/outputs/weights-run/1', bob, 'GET', undefined, 'b'), { params: Promise.resolve({ dataset: 'weights-run', version: '1' }) })).status).toBe(404);
    const legacySpy = vi.spyOn(service, 'legacy');
    expect((await legacyModels(request('/api/models/legacy', alice))).status).toBe(403);
    expect(legacySpy).not.toHaveBeenCalled();
    const response = await legacyModels(request('/api/models/legacy', admin));
    expect(await response.json()).toMatchObject({ approvalMeaning: 'smoke_only', sources: [{ status: 'error', error: 'Registry test error' }] });
  });
  it('rejects direct numbers, accepts published report evidence, and approves only the server gate', async () => {
    const model = await service.register(alice, 'a', body);
    const input = { modelId: model.id, dataset: 'evaluation-run', version: 1, reportPath: 'evaluation.json' };
    expect((await ingest(request('/api/evaluations', alice, 'POST', { ...input, successes: 999, episodes: 999 }))).status).toBe(400);
    const evaluation = await (await ingest(request('/api/evaluations', alice, 'POST', input))).json();
    expect(evaluation.metrics.kind).toBe('simulation');
    const denied = await getEvaluation(request(`/api/evaluations/${evaluation.id}`, bob, 'GET', undefined, 'b'), { params: Promise.resolve({ id: evaluation.id }) });
    expect(denied.status).toBe(404);
    const gate = await promote(request(`/api/models/${model.id}/promotion`, alice, 'POST', { evaluationId: evaluation.id, approve: true }), { params: Promise.resolve({ id: model.id }) });
    expect((await gate.json()).model.qualityApproval).toMatchObject({ approved: true, policy: services.DEFAULT_POLICY });
    const signed = await getArtifact(request(`/api/evaluations/${evaluation.id}/artifact?kind=report`), { params: Promise.resolve({ id: evaluation.id }) });
    expect(signed.status).toBe(302);
    expect(signed.headers.get('location')).toContain('versionId=object-v1');
    expect(signed.headers.get('cache-control')).toContain('no-store');
  });
  it('cannot approve another model using a valid evaluation ID', async () => {
    const model = await service.register(alice, 'a', body);
    const evaluation = await service.ingest(alice, 'a', { modelId: model.id, dataset: 'evaluation-run', version: 1 });
    const response = await promote(request('/api/models/mdl-other/promotion', alice, 'POST', { evaluationId: evaluation.id, approve: true }), { params: Promise.resolve({ id: 'mdl-other' }) });
    expect(response.status).toBe(404);
    expect((await service.get(alice, 'a', model.id)).model.qualityApproval).toBeUndefined();
  });
});
