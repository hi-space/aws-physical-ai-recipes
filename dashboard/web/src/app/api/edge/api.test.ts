import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as list } from './route';
import { POST as register } from './devices/route';
import { GET as getDevice } from './devices/[id]/route';
import { POST as prepare } from './deployments/route';
import { POST as submit } from './operations/[id]/submit/route';
import { GET as getOperation } from './operations/[id]/route';
import { POST as claim } from './devices/[id]/lease/route';
import { POST as prove } from './devices/[id]/lease/[action]/route';
import { POST as benchmark } from './devices/[id]/benchmarks/route';
import * as services from '@/server/services/devices';
import { setRepoForTests } from '@/server/store/repo';
import { resetConfigForTests } from '@/server/config';
import { fixture, registration, alice, bob, reader, sample } from './fixtures';
import type { Session } from '@/server/auth/session';
let data: Awaited<ReturnType<typeof fixture>>;
const request = (path: string, session: Session = alice, method = 'GET', body?: unknown, project = 'a', origin = 'http://localhost') =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'x-pai-user': session.user, 'x-pai-subject': session.subject!, 'x-pai-role': session.role,
    'x-pai-groups': (session.groups ?? []).join(','),
    'x-pai-project': project, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.stubEnv('DASHBOARD_ORIGIN', 'http://localhost'); resetConfigForTests();
  data = await fixture(); setRepoForTests(data.repo); vi.spyOn(services, 'devicesService').mockReturnValue(data.service);
});
describe('edge HTTP project boundary', () => {
  it('requires project-admin registration and same-origin mutations', async () => {
    expect((await register(request('/api/edge/devices', reader, 'POST', registration()))).status).toBe(403);
    expect((await register(request('/api/edge/devices', alice, 'POST', registration(), 'a', 'https://other.invalid'))).status).toBe(403);
    const response = await register(request('/api/edge/devices', alice, 'POST', registration()));
    expect(response.status).toBe(200);
    const device = await response.json();
    expect((await (await list(request('/api/edge', bob, 'GET', undefined, 'b'))).json()).devices).toEqual([]);
    expect((await getDevice(request(`/api/edge/devices/${device.id}`, bob, 'GET', undefined, 'b'), { params: Promise.resolve({ id: device.id }) })).status).toBe(404);
    expect(data.cloud.creates).toHaveLength(0);
  });
  it('never accepts an arbitrary target ARN, model path, or direct component override', async () => {
    expect((await prepare(request('/api/edge/deployments', alice, 'POST', { name: 'unsafe', targetArn: 'arn:unsafe', modelPath: '/tmp/model', extraComponents: {} }))).status).toBe(400);
    const d = await data.service.register(alice, 'a', registration());
    const response = await prepare(request('/api/edge/deployments', alice, 'POST', { name: 'Prepared', deviceId: d.id, profileId: d.profiles[0].id, modelId: data.model.id }));
    const op = await response.json();
    expect(response.status).toBe(200); expect(op.status).toBe('PREPARED'); expect(data.cloud.creates).toHaveLength(0);
    expect((await submit(request(`/api/edge/operations/${op.id}/submit`, alice, 'POST', { targetArn: 'arn:override' }), { params: Promise.resolve({ id: op.id }) })).status).toBe(400);
    const sent = await submit(request(`/api/edge/operations/${op.id}/submit`, alice, 'POST', {}), { params: Promise.resolve({ id: op.id }) });
    expect((await sent.json()).status).toBe('SUBMITTED');
    expect(data.cloud.creates[0].targetArn).toBe(d.targetArn);
    expect((await getOperation(request(`/api/edge/operations/${op.id}`, bob, 'GET', undefined, 'b'), { params: Promise.resolve({ id: op.id }) })).status).toBe(404);
  });
  it('scopes lease proofs and never turns client numbers into verified operation results', async () => {
    const d = await data.service.register(alice, 'a', { ...registration('virtual-a'), kind: 'virtual', profiles: [] });
    const lease = await (await claim(request(`/api/edge/devices/${d.id}/lease`, alice, 'POST', { runId: 'active-run', ttlSeconds: 30 }), { params: Promise.resolve({ id: d.id }) })).json();
    expect(lease.epoch).toBe(1);
    const denied = await prove(request(`/api/edge/devices/${d.id}/lease/release`, bob, 'POST', { runId: lease.runId, epoch: lease.epoch, token: lease.token }, 'b'), { params: Promise.resolve({ id: d.id, action: 'release' }) });
    expect(denied.status).toBe(404);
    const input = { source: 'imported', payload: [sample], engine: { name: 'pytorch' }, platform: { architecture: 'amd64', description: 'user log' } };
    const imported = await benchmark(request(`/api/edge/devices/${d.id}/benchmarks`, alice, 'POST', input), { params: Promise.resolve({ id: d.id }) });
    expect((await imported.json()).verification).toBe('imported');
    expect((await benchmark(request(`/api/edge/devices/${d.id}/benchmarks`, alice, 'POST', { ...input, source: 'operation-artifact', operationId: 'fake' }), { params: Promise.resolve({ id: d.id }) })).status).toBe(400);
  });
});
