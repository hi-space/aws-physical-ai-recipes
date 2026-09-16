import { beforeEach, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Workflow } from '../store/types';
import { LogArchive } from './archive';
import { createLogCollector, type CollectorDeps } from './collector';
let repo: Repo, wf: Workflow, pod: any, deps: CollectorDeps, archive: LogArchive, opened: number;
beforeEach(async () => {
  repo = new Repo(new MemoryKV()); archive = new LogArchive({ repo }); opened = 0;
  wf = { id: 'w', name: 'w', projectId: 'p', namespace: 'research', status: 'RUNNING', spec: { workflow: { tasks: [{ name: 'train' }] } } } as Workflow;
  pod = { metadata: { name: 'pod', uid: 'uid', namespace: 'research', labels: { 'app.kubernetes.io/managed-by': 'physical-ai-dashboard',
    'pai.aws/workflow-id': 'w', 'pai.aws/project': 'p', 'pai.aws/task': 'train', 'pai.aws/attempt': '1', 'pai.aws/epoch': 'e' } },
    spec: { containers: [{ name: 'main' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'main', restartCount: 0, state: { running: {} } }] } };
  await repo.putWorkflow(wf);
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'research' });
  await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', name: 'train', attempts: 1, attemptEpoch: 'e', phase: 'RUNNING' });
  deps = { repo, secrets: async () => [], getPod: async () => pod, listPods: async () => [pod],
    open: async () => new ReadableStream({ start(c) { c.enqueue(Buffer.from(`capture-${++opened}\n`)); } }) };
});
async function captured() {
  await vi.waitFor(async () => {
    const head = (await archive.list('w', 'train')).streams[0];
    expect(head?.bytes).toBeGreaterThan(0);
  });
}
it('captures before any API request and drains received bytes before marking the archive closed', async () => {
  const collector = createLogCollector(deps); await collector.reconcile(wf); await captured();
  expect(await collector.drain('w', { attempt: 1 })).toEqual({ drained: true, coverage: 'captured-only' });
  const head = (await archive.list('w', 'train')).streams[0];
  expect(head.state).toBe('closed');
  expect((await archive.read(head.id, 0)).records.some(r => r.reason === 'capture-stop')).toBe(true);
  await collector.reconcile(wf); expect(opened).toBe(1);
});
it('finishes a fast terminated container before installing the destructive drain fence', async () => {
  pod.status.phase = 'Succeeded';
  pod.status.containerStatuses[0].state = { terminated: { exitCode: 0 } };
  deps.secrets = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return []; };
  deps.open = async () => new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('first and final line\n')); controller.close();
  } });
  const collector = createLogCollector(deps);
  await collector.reconcile(wf);
  expect(await collector.settleCompleted(wf.id, { taskNames: ['train'], attempt: 1 })).toEqual({ settled: true });
  expect(await collector.drain(wf.id, { taskName: 'train', attempt: 1 })).toMatchObject({ drained: true });
  const head = (await archive.list(wf.id, 'train')).streams[0];
  const bytes = (await archive.read(head.id, 0)).records.filter(record => record.kind === 'data')
    .map(record => Buffer.from(record.data!, 'base64').toString()).join('');
  expect(bytes).toBe('first and final line\n');
  expect(head.state).toBe('closed');
});
it('records an inventory reset and restarts the same UID at a marked source boundary', async () => {
  const collector = createLogCollector(deps); await collector.reconcile(wf); await captured();
  await collector.reconcile(wf, { pods: [pod], reset: true });
  await vi.waitFor(() => expect(opened).toBe(2));
  await collector.drain('w');
  const head = (await archive.list('w', 'train')).streams[0], page = await archive.read(head.id, 0);
  expect(page.records.some(r => r.reason === 'watch-reset')).toBe(true);
  expect(page.records.some(r => r.reason === 'source-reconnect')).toBe(true);
});
it.each(['project', 'attempt', 'epoch', 'backend'])('rejects a Pod from the wrong %s before resolving secrets or opening logs', async field => {
  const keys = { project: 'pai.aws/project', attempt: 'pai.aws/attempt', epoch: 'pai.aws/epoch', backend: 'pai.aws/backend' };
  pod.metadata.labels[keys[field as keyof typeof keys]] = 'other';
  const collector = createLogCollector(deps); await collector.reconcile(wf);
  expect((await archive.list('w', 'train')).streams).toEqual([]); expect(opened).toBe(0);
});
it('surfaces secret-resolution failure through drain without storing any original bytes', async () => {
  deps.secrets = async () => { throw new Error('known secret must never be included in diagnostics'); };
  const collector = createLogCollector(deps); await collector.reconcile(wf);
  await expect(collector.drain('w')).rejects.toMatchObject({ status: 503, message: 'Log capture/storage failed during drain' });
  expect(opened).toBe(0);
});
it('does not report drained while another controller owns the stream, and persists the stop fence', async () => {
  const first = createLogCollector(deps), second = createLogCollector(deps);
  await first.reconcile(wf); await captured();
  expect(await second.drain('w', { attempt: 1, timeoutMs: 10 })).toMatchObject({ drained: false });
  expect(await repo.kv.get('WF#w', 'LOG_DRAIN#ALL#1')).toBeDefined();
  await first.reconcile(wf);
  expect(await second.drain('w', { attempt: 1 })).toMatchObject({ drained: true });
  await createLogCollector(deps).reconcile(wf); expect(opened).toBe(1);
});
it('fails closed if a secret-bearing Pod is wired to an empty redaction resolver', async () => {
  pod.spec.containers[0].env = [{ name: 'PAI_RUNTIME_TOKEN', valueFrom: { secretKeyRef: { name: 'job-creds', key: 'PAI_RUNTIME_TOKEN' } } }];
  const collector = createLogCollector(deps); await collector.reconcile(wf);
  await expect(collector.drain('w')).rejects.toMatchObject({ status: 503 });
  expect(opened).toBe(0);
});
