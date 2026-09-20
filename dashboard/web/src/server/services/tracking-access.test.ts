import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Session } from '../auth/session';
import { testSession } from '../auth/session.test-helpers';
import type { MlExperiment, MlRun } from '../aws/mlflow';
import { TrackingAccess, type TrackingUpstream } from './tracking-access';

const alice: Session = testSession('alice', 'alice-sub', 'researcher', ['proj-a', 'proj-b']);
const admin: Session = testSession('admin', 'admin-sub', 'admin');
const exp = (id: string, name: string): MlExperiment => ({ experiment_id: id, name, lifecycle_stage: 'active' });
const run = (id: string, experiment: string, project?: string): MlRun => ({
  info: { run_id: id, experiment_id: experiment, status: 'RUNNING', start_time: 1 },
  data: { tags: project ? [{ key: 'pai.project_id', value: project }] : [], metrics: [{ key: 'loss', value: 0.2, step: 1, timestamp: 1 }] },
});
let repo: Repo;
let experiments: Map<string, MlExperiment>;
let runs: Map<string, MlRun>;
let upstream: TrackingUpstream;
let service: TrackingAccess;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  for (const id of ['a', 'b']) await repo.kv.put({
    pk: `PROJECT#${id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: id, id, name: id,
  });
  experiments = new Map([
    ['exp-a', exp('exp-a', 'pai/a/training')], ['exp-b', exp('exp-b', 'pai/b/training')],
    ['collision', exp('collision', 'pai/ab/training')], ['empty', exp('empty', 'pai/a/')],
    ['legacy', exp('legacy', 'legacy-workshop')],
  ]);
  runs = new Map([
    ['owned', run('owned', 'exp-a', 'a')], ['other', run('other', 'exp-b', 'b')],
    ['missing-tag', run('missing-tag', 'exp-a')], ['wrong-tag', run('wrong-tag', 'exp-a', 'b')],
    ['wrong-experiment', run('wrong-experiment', 'exp-b', 'a')], ['legacy-tagged', run('legacy-tagged', 'legacy', 'a')],
    ['ambiguous-tag', { ...run('ambiguous-tag', 'exp-a', 'a'), data: { tags: [{ key: 'pai.project_id', value: 'a' }, { key: 'pai.project_id', value: 'b' }] } }],
  ]);
  upstream = {
    searchExperiments: vi.fn(async () => [...experiments.values()]),
    getExperiment: vi.fn(async id => experiments.get(id)!),
    searchRuns: vi.fn(async () => [...runs.values()]), getRun: vi.fn(async id => runs.get(id)!),
    listArtifacts: vi.fn(async () => [{ path: 'model.zip', is_dir: false, file_size: 123 }]),
    getMetricHistory: vi.fn(async (_id, key) => [{ key, value: 0.2, step: 1, timestamp: 1 }]),
    searchRegisteredModels: vi.fn(async () => [{ name: 'legacy-model' }]),
  };
  service = new TrackingAccess(repo, upstream);
});

describe('MLflow selected-project isolation', () => {
  it.each([alice, admin])('filters experiment names for the selected project even for $role', async session => {
    expect(await service.experiments(session, 'a')).toEqual([experiments.get('exp-a')]);
    expect(upstream.searchExperiments).toHaveBeenCalledWith("name LIKE 'pai/a/%'");
  });
  it('checks project membership before any MLflow call', async () => {
    await expect(service.experiments({ ...alice, subject: 'outsider', groups: ['researchers'] }, 'a')).rejects.toMatchObject({ status: 403 });
    expect(upstream.searchExperiments).not.toHaveBeenCalled();
  });
  it('requires both allowed experiment and exactly matching run tag, regardless of the upstream filter response', async () => {
    const found = await service.runs(alice, 'a', ['exp-a'], 'metrics.loss < 1', 50);
    expect(found.map(r => r.info.run_id)).toEqual(['owned']);
    expect(upstream.searchRuns).toHaveBeenCalledWith(['exp-a'], "tags.`pai.project_id` = 'a' AND metrics.loss < 1", 50);
  });
  it('does not let a caller filter replace the mandatory project checks', async () => {
    const values = await service.runs(alice, 'a', ['exp-a'], "tags.`pai.project_id` = 'b' OR metrics.loss < 1");
    expect(values.map(value => value.info.run_id)).toEqual(['owned']);
  });
  it('rejects experiment namespace changes during run search', async () => {
    vi.mocked(upstream.searchRuns).mockImplementation(async () => {
      experiments.set('exp-a', exp('exp-a', 'pai/b/renamed'));
      return [runs.get('owned')!];
    });
    await expect(service.runs(alice, 'a', ['exp-a'])).rejects.toMatchObject({ status: 404 });
  });
  it.each([alice, admin])('does not broaden multi-experiment queries across selected projects for $role', async session => {
    await expect(service.runs(session, 'a', ['exp-a', 'exp-b'])).rejects.toMatchObject({ status: 404 });
    expect(upstream.searchRuns).not.toHaveBeenCalled();
  });
  it.each(['other', 'missing-tag', 'wrong-tag', 'wrong-experiment', 'legacy-tagged', 'ambiguous-tag'])('denies foreign or unproven concrete run %s before reading artifacts/history', async id => {
    await expect(service.detail(alice, 'a', id)).rejects.toMatchObject({ status: 404 });
    await expect(service.history(alice, 'a', id, ['loss'])).rejects.toMatchObject({ status: 404 });
    expect(upstream.listArtifacts).not.toHaveBeenCalled();
    expect(upstream.getMetricHistory).not.toHaveBeenCalled();
  });
  it('returns owned detail and history and rechecks ownership on every request', async () => {
    expect((await service.detail(alice, 'a', 'owned')).run.info.run_id).toBe('owned');
    expect(await service.history(alice, 'a', 'owned', ['loss'])).toEqual({ loss: [{ key: 'loss', value: 0.2, step: 1, timestamp: 1 }] });
    runs.set('owned', run('owned', 'exp-a', 'b'));
    await expect(service.detail(alice, 'a', 'owned')).rejects.toMatchObject({ status: 404 });
  });
  it('fails closed if the run loses its project tag while its history is being fetched', async () => {
    vi.mocked(upstream.getMetricHistory).mockImplementation(async () => {
      runs.set('owned', run('owned', 'exp-a', 'b'));
      return [{ key: 'secret', value: 123, step: 1, timestamp: 1 }];
    });
    await expect(service.history(alice, 'a', 'owned', ['secret'])).rejects.toMatchObject({ status: 404 });
  });
  it('does not hide authorized artifact-source failures as an empty list', async () => {
    vi.mocked(upstream.listArtifacts).mockRejectedValue(new Error('upstream unavailable'));
    await expect(service.detail(alice, 'a', 'owned')).rejects.toThrow('upstream unavailable');
  });
  it('uses a dedicated admin-only legacy context and does not allow project tokens to escape it', async () => {
    await expect(service.legacyModels(alice)).rejects.toMatchObject({ status: 403 });
    await expect(service.legacyModels({ ...admin, authMethod: 'token', tokenProjectId: 'a' })).rejects.toMatchObject({ status: 403 });
    expect(upstream.searchRegisteredModels).not.toHaveBeenCalled();
    expect(await service.legacyModels(admin)).toEqual([{ name: 'legacy-model' }]);
    await expect(service.detail(admin, 'a', 'other')).rejects.toMatchObject({ status: 404 });
  });
  it('enforces project-token scope even when called directly by another service', async () => {
    await expect(service.experiments({ ...admin, authMethod: 'token', tokenProjectId: 'b' }, 'a')).rejects.toMatchObject({ status: 403 });
    expect(upstream.searchExperiments).not.toHaveBeenCalled();
  });
  it('validates bounded IDs/queries and safely represents a metric named __proto__', async () => {
    await expect(service.runs(alice, 'a', [])).rejects.toMatchObject({ status: 400 });
    await expect(service.runs(alice, 'a', ['exp-a'], '', 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.history(alice, 'a', 'owned', Array(17).fill('loss'))).rejects.toMatchObject({ status: 400 });
    const result = await service.history(alice, 'a', 'owned', ['__proto__']);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
