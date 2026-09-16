import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as experiments } from './experiments/route';
import { GET as runs } from './runs/route';
import { GET as detail } from './runs/[id]/route';
import { GET as metrics } from './runs/[id]/metrics/route';
import { GET as legacyModels } from './models/route';
import * as access from '@/server/services/tracking-access';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import type { MlRun } from '@/server/aws/mlflow';

let upstream: access.TrackingUpstream;
const experiment = (id: string, project: string) => ({ experiment_id: id, name: `pai/${project}/workflow`, lifecycle_stage: 'active' });
const run = (id: string, project: string, experimentId: string): MlRun => ({
  info: { run_id: id, experiment_id: experimentId, status: 'RUNNING', start_time: 1 },
  data: { tags: [{ key: 'pai.project_id', value: project }] },
});
const request = (path: string, role = 'researcher', project = 'a') => new NextRequest(`http://localhost${path}`, {
  headers: { 'x-pai-user': 'alice', 'x-pai-subject': 'alice-sub', 'x-pai-role': role, 'x-pai-project': project },
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  for (const id of ['a', 'b']) await repo.kv.put({
    pk: `PROJECT#${id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: id, id, name: id,
    members: { 'alice-sub': 'researcher' },
  });
  const exps = new Map([['exp-a', experiment('exp-a', 'a')], ['exp-b', experiment('exp-b', 'b')]]);
  const records = new Map([['run-a', run('run-a', 'a', 'exp-a')], ['run-b', run('run-b', 'b', 'exp-b')]]);
  upstream = {
    searchExperiments: vi.fn(async () => [...exps.values()]),
    getExperiment: vi.fn(async id => exps.get(id)!),
    searchRuns: vi.fn(async () => [...records.values()]), getRun: vi.fn(async id => records.get(id)!),
    listArtifacts: vi.fn(async () => [{ path: 'checkpoint.zip', is_dir: false }]),
    getMetricHistory: vi.fn(async (_id, key) => [{ key, value: 1, step: 1, timestamp: 1 }]),
    searchRegisteredModels: vi.fn(async () => [{ name: 'legacy-unscoped-model' }]),
  };
  vi.spyOn(access, 'trackingAccess').mockReturnValue(new access.TrackingAccess(repo, upstream));
});
describe('MLflow HTTP project boundary', () => {
  it.each(['researcher', 'admin'])('keeps ordinary %s experiment/run views inside the selected project', async role => {
    expect(await (await experiments(request('/api/mlflow/experiments', role))).json()).toEqual([experiment('exp-a', 'a')]);
    expect(await (await runs(request('/api/mlflow/runs?experiment=exp-a', role))).json()).toEqual([run('run-a', 'a', 'exp-a')]);
    expect((await runs(request('/api/mlflow/runs?experiment=exp-b&scope=legacy', role))).status).toBe(404);
  });
  it('rechecks run and experiment ownership before fetching concrete artifacts/history', async () => {
    const ctx = { params: Promise.resolve({ id: 'run-b' }) };
    expect((await detail(request('/api/mlflow/runs/run-b'), ctx)).status).toBe(404);
    expect((await metrics(request('/api/mlflow/runs/run-b/metrics?key=loss'), ctx)).status).toBe(404);
    expect(upstream.listArtifacts).not.toHaveBeenCalled();
    expect(upstream.getMetricHistory).not.toHaveBeenCalled();
    const owned = { params: Promise.resolve({ id: 'run-a' }) };
    expect((await detail(request('/api/mlflow/runs/run-a'), owned)).status).toBe(200);
    expect(await (await metrics(request('/api/mlflow/runs/run-a/metrics?key=loss'), owned)).json()).toEqual({
      loss: [{ key: 'loss', value: 1, step: 1, timestamp: 1 }],
    });
    expect((await detail(request('/api/mlflow/runs/run-a', 'admin', 'b'), owned)).status).toBe(404);
  });
  it('uses the selected project cookie when the header is absent', async () => {
    const req = new NextRequest('http://localhost/api/mlflow/experiments', {
      headers: { 'x-pai-user': 'alice', 'x-pai-subject': 'alice-sub', 'x-pai-role': 'researcher', cookie: 'pai-project=b' },
    });
    expect(await (await experiments(req)).json()).toEqual([experiment('exp-b', 'b')]);
  });
  it('makes legacy registered models admin-only without a selected-project bypass elsewhere', async () => {
    expect((await legacyModels(request('/api/mlflow/models'))).status).toBe(403);
    expect(upstream.searchRegisteredModels).not.toHaveBeenCalled();
    expect(await (await legacyModels(request('/api/mlflow/models', 'admin'))).json()).toEqual([{ name: 'legacy-unscoped-model' }]);
  });
  it('rejects missing/unbounded query parameters rather than making a global upstream request', async () => {
    expect((await runs(request('/api/mlflow/runs'))).status).toBe(400);
    expect((await runs(request('/api/mlflow/runs?experiment=exp-a&max=bad'))).status).toBe(400);
    expect((await metrics(request('/api/mlflow/runs/run-a/metrics'), { params: Promise.resolve({ id: 'run-a' }) })).status).toBe(400);
    expect(upstream.searchRuns).not.toHaveBeenCalled();
    expect(upstream.getMetricHistory).not.toHaveBeenCalled();
  });
});
