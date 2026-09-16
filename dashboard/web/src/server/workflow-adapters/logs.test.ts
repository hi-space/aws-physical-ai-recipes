import { beforeEach, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Workflow } from '../store/types';
const collector = vi.hoisted(() => ({
  reconcile: vi.fn(), settleCompleted: vi.fn(), drain: vi.fn(),
}));
vi.mock('../logs/collector', () => ({ createLogCollector: () => collector }));
import { workflowLogHooks } from './logs';
beforeEach(() => {
  vi.clearAllMocks();
  collector.reconcile.mockResolvedValue(undefined);
  collector.settleCompleted.mockResolvedValue({ settled: true });
  collector.drain.mockResolvedValue({ drained: true });
});
it('records incomplete drain without preventing bounded workload cleanup or exposing provider errors', async () => {
  const repo = new Repo(new MemoryKV());
  const workflow = { id: 'run', name: 'run', namespace: 'team', projectId: 'p', owner: 'alice', status: 'RUNNING',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Workflow;
  await repo.putWorkflow(workflow);
  collector.settleCompleted.mockResolvedValue({ settled: false });
  collector.drain.mockRejectedValue(new Error('provider-secret-canary'));
  const hooks = workflowLogHooks(repo);
  await expect(hooks.drain(workflow, ['lead', 'peer'], 2)).resolves.toBeUndefined();
  expect(collector.drain).toHaveBeenCalledTimes(2);
  expect(await repo.kv.get('WF#run', 'LOG_CAPTURE_STATUS')).toMatchObject({ state: 'incomplete', reason: 'LogDrainIncomplete', coverage: 'captured-only' });
  const rows = await repo.kv.query('WF#run');
  expect(JSON.stringify(rows)).not.toContain('provider-secret-canary');
});
