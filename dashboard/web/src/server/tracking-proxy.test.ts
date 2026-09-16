import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { authenticate, call, s3send } = vi.hoisted(() => ({ authenticate: vi.fn(), call: vi.fn(), s3send: vi.fn() }));
vi.mock('./runtime', () => ({ validateMetricsCapability: authenticate }));
vi.mock('./aws/mlflow', () => ({ mlflowApi: call }));
vi.mock('./aws/clients', () => ({ dynamo: vi.fn(), s3: () => ({ send: s3send }) }));
import { Repo, setRepoForTests } from './store/repo';
import { MemoryKV } from './store/dynamo';
import { handleTrackingRequest } from './tracking-proxy';

const owned = { info: { run_id: 'owned-run', experiment_id: 'experiment', status: 'RUNNING', start_time: 1, artifact_uri: 's3://artifacts/mlflow/owned-run/artifacts' }, data: {} };
beforeEach(() => {
  setRepoForTests(new Repo(new MemoryKV()));
  authenticate.mockReset().mockResolvedValue({
    claims: { projectId: 'team-a', workflowId: 'run123', task: 'train', attempt: 1 },
    workflow: { id: 'run123', name: 'training', ownerSubject: 'alice', spec: { workflow: { mlflow: true } } },
  });
  call.mockReset().mockImplementation(async (_method, path) => {
    if (path === 'experiments/get-by-name') return { experiment: { experiment_id: 'experiment' } };
    if (path === 'runs/search') return { runs: [] };
    if (path === 'runs/create' || path === 'runs/get') return { run: owned };
    return {};
  });
});
async function request(path: string, body: unknown) {
  const server = createServer((req, res) => { void handleTrackingRequest(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    return await fetch(`http://127.0.0.1:${address.port}/tracking/api/2.0/mlflow/${path}`, {
      method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } finally { server.close(); }
}
describe('task-scoped experiment logging', () => {
  it('creates a tagged run and presents an authenticated artifact endpoint', async () => {
    const response = await request('runs/create', { experiment_id: 'someone-else' });
    expect(response.status).toBe(200);
    expect((await response.json()).run.info.artifact_uri).toBe('mlflow-artifacts:/owned-run');
    expect(call.mock.calls.find((args) => args[1] === 'runs/create')?.[2]).toMatchObject({
      experiment_id: 'experiment', tags: expect.arrayContaining([{ key: 'pai.project_id', value: 'team-a' }]),
    });
  });
  it('rejects writing to another run and changing provenance tags', async () => {
    expect((await request('runs/log-metric', { run_id: 'other', key: 'reward', value: 1 })).status).toBe(403);
    expect((await request('runs/set-tag', { run_id: 'owned-run', key: 'pai.project_id', value: 'other' })).status).toBe(403);
    expect(call.mock.calls.some((args) => args[1] === 'runs/log-metric' || args[1] === 'runs/set-tag')).toBe(false);
  });
  it('forwards actual metric values only after checking the current attempt', async () => {
    const response = await request('runs/log-metric', { run_id: 'owned-run', key: 'loss', value: 0.25, step: 7, timestamp: 100 });
    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledWith('POST', 'runs/log-metric', { run_id: 'owned-run', key: 'loss', value: 0.25, step: 7, timestamp: 100 });
    expect(authenticate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
