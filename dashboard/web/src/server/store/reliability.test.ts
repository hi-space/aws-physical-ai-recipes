import { afterEach, expect, it, vi } from 'vitest';
import { MemoryKV } from './dynamo';
import { Repo } from './repo';
afterEach(() => vi.useRealTimers());
it('fences stale lease writers, refuses same-owner reacquisition and renews only live leases', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const repo = new Repo(new MemoryKV());
  const lease = await repo.acquireRunLease('r', 30);
  expect(lease).toBeDefined();
  expect(await repo.acquireRunLease('r', 30)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await repo.renewRunLease(lease!, 30)).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await repo.acquireRunLease('r', 30)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(11_000);
  const next = await repo.acquireRunLease('r', 30);
  expect(next).toBeDefined();
  expect(await repo.renewRunLease(lease!, 30)).toBe(false);
  await expect(repo.putTask({
    workflowId: 'r',
    name: 'a',
    attempts: 1,
    phase: 'RUNNING',
    replicas: 1,
    updatedAt: 'now'
  }, lease!)).rejects.toThrow(/lease/i);
  await repo.releaseRunLease(lease!);
  expect(await repo.acquireRunLease('r', 30)).toBeUndefined();
});
it('publishes simultaneous versions atomically and deduplicates publication after crash', async () => {
  const repo = new Repo(new MemoryKV());
  const dataset = {
    name: 'out',
    owner: 'a',
    tags: [],
    latestVersion: 0,
    createdAt: 'x',
    updatedAt: 'x'
  };
  const version = {
    dataset: 'out',
    uri: 's3://b/p',
    tags: [],
    createdAt: 'x',
    createdBy: 'a'
  };
  const [a, b] = await Promise.all([repo.publishDatasetVersion(dataset, version, 'pub-a'), repo.publishDatasetVersion(dataset, version, 'pub-b')]);
  expect(new Set([a.version, b.version])).toEqual(new Set([1, 2]));
  expect((await repo.getDataset('out'))?.latestVersion).toBe(2);
  expect((await repo.publishDatasetVersion(dataset, version, 'pub-a')).version).toBe(a.version);
  expect(await repo.listVersions('out')).toHaveLength(2);
});
it('paginates every workflow without duplicates and validates cursor', async () => {
  const repo = new Repo(new MemoryKV());
  for (let i = 0; i < 7; i++) await repo.putWorkflow({
    id: `r${i}`,
    name: 'r',
    namespace: 'rl',
    owner: 'a',
    status: 'PENDING',
    spec: {} as never,
    specYaml: '',
    vars: {},
    taskCount: 1,
    succeededCount: 0,
    failedCount: 0,
    createdAt: `2026-01-0${i + 1}`,
    updatedAt: 'x'
  });
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await repo.listWorkflowsPage({
      limit: 2,
      cursor
    });
    ids.push(...page.items.map(x => x.id));
    cursor = page.cursor;
  } while (cursor);
  expect(ids).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0']);
  await expect(repo.listWorkflowsPage({
    cursor: 'bad'
  })).rejects.toThrow(/cursor/i);
});
it('paginates projects independently of other projects and updates projections atomically', async () => {
  const repo = new Repo(new MemoryKV());
  const base = {
    name: 'r',
    namespace: 'n',
    owner: 'a',
    status: 'PENDING' as const,
    spec: {} as never,
    specYaml: '',
    vars: {},
    taskCount: 1,
    succeededCount: 0,
    failedCount: 0,
    updatedAt: 'x'
  };
  for (let i = 0; i < 205; i++) await repo.putWorkflow({
    ...base,
    id: `busy${i}`,
    projectId: 'busy',
    createdAt: '2026-02-01'
  });
  await repo.putWorkflow({
    ...base,
    id: 'quiet',
    projectId: 'quiet',
    createdAt: '2026-01-01'
  });
  const page = await repo.listWorkflowsPage({
    projectId: 'quiet',
    limit: 1
  });
  expect(page.items.map(w => w.id)).toEqual(['quiet']);
  const w = page.items[0];
  await repo.putWorkflow({
    ...w,
    status: 'SUCCEEDED'
  });
  expect((await repo.listWorkflows({
    projectId: 'quiet',
    limit: 1
  }))[0].status).toBe('SUCCEEDED');
  await repo.deleteWorkflow('quiet');
  expect(await repo.listWorkflows({
    projectId: 'quiet'
  })).toEqual([]);
});
it('refuses publication from a stale task attempt even when the caller holds the current run lease', async () => {
  const repo = new Repo(new MemoryKV());
  const lease = (await repo.acquireRunLease('r'))!;
  await repo.putTask({
    workflowId: 'r',
    name: 't',
    phase: 'RUNNING',
    attempts: 2,
    replicas: 1,
    updatedAt: 'x'
  }, lease);
  await expect(repo.publishDatasetVersion({
    name: 'out',
    owner: 'a',
    tags: [],
    latestVersion: 0,
    createdAt: 'x',
    updatedAt: 'x'
  }, {
    dataset: 'out',
    uri: 's3://b/p',
    tags: [],
    createdAt: 'x',
    createdBy: 'a',
    producedBy: {
      workflowId: 'r',
      task: 't'
    },
    producedAttempt: 1
  }, 'stale', lease)).rejects.toThrow(/attempt/);
  expect(await repo.getDataset('out')).toBeUndefined();
});
