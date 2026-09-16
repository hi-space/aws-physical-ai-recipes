import { beforeEach, expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import { RuntimeBroker } from './broker';
const yaml = `workflow:
  name: runtime
  namespace: team
  resources: { cpu: {cpu: 1} }
  groups:
    - name: pair
      ignoreNonleadStatus: true
      tasks:
        - {name: lead, lead: true, resource: cpu, image: busybox, command: [echo, ok]}
        - {name: worker, resource: cpu, image: busybox, parallelism: 2, command: [echo, ok]}
`;
let repo: Repo, broker: RuntimeBroker, wf: Workflow, clock: Date;
const token = (name: string) => broker.environment(wf, wf.spec.workflow.tasks.find(t => t.name === name)!, 'epoch', 1).PAI_RUNTIME_TOKEN;
beforeEach(async () => {
  clock = new Date('2026-09-16T00:00:00Z');
  repo = new Repo(new MemoryKV());
  wf = {
    id: 'run',
    projectId: 'p',
    ownerSubject: 'sub',
    name: 'runtime',
    namespace: 'team',
    owner: 'alice',
    status: 'RUNNING',
    spec: parseWorkflowYaml(yaml).spec,
    specYaml: yaml,
    vars: {},
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
    taskCount: 2,
    succeededCount: 0,
    failedCount: 0
  };
  await repo.putWorkflow(wf);
  for (const t of wf.spec.workflow.tasks) await repo.putTask({
    workflowId: wf.id,
    name: t.name,
    groupId: 'pair',
    attemptEpoch: 'epoch',
    attempts: 1,
    phase: 'RUNNING',
    replicas: t.parallelism,
    updatedAt: clock.toISOString()
  });
  broker = new RuntimeBroker({
    repo,
    now: () => clock,
    signingKey: 'a'.repeat(64),
    apiUrl: 'http://worker:8080',
    artifactBucket: 'artifacts'
  });
});
it('rechecks trusted policy after readiness and before application RUNNING, without changing the durable member on denial', async () => {
  let allowed = true;
  broker.deps.validateTaskPolicy = async () => { if (!allowed) throw Object.assign(new Error('approval revoked'), { status: 403 }); };
  for (const [task, replica] of [['lead', 0], ['worker', 0], ['worker', 1]] as const) {
    await broker.state(token(task), { phase: 'INITIALIZING', ready: true, replica });
  }
  allowed = false;
  await expect(broker.barrier(token('lead'), 0)).rejects.toMatchObject({ status: 403 });
  const before = await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#');
  expect(before.every(row => row.processStarted === false)).toBe(true);
  allowed = true;
  expect((await broker.barrier(token('lead'), 0)).released).toBe(true);
  allowed = false;
  await expect(broker.state(token('lead'), { phase: 'RUNNING', ready: true, replica: 0 })).rejects.toMatchObject({ status: 403 });
  expect(await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#')).toEqual(before);
});
it.each(['barrier', 'running'] as const)('atomically rejects approval withdrawal between validation and the %s write', async phase => {
  for (const [task, replica] of [['lead', 0], ['worker', 0], ['worker', 1]] as const) {
    await broker.state(token(task), { phase: 'INITIALIZING', ready: true, replica });
  }
  if (phase === 'running') await broker.barrier(token('lead'), 0);
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'EXECUTION_PROFILE#device', enabled: true, version: 1 });
  broker.deps.validateTaskPolicy = async () => [{ kind: 'check', pk: 'PROJECT#p', sk: 'EXECUTION_PROFILE#device',
    condition: { equals: { enabled: true, version: 1 } } }];
  const transaction = repo.kv.transaction.bind(repo.kv);
  let revoked = false;
  repo.kv.transaction = async writes => {
    if (!revoked && writes.some(write => write.kind === 'check' && write.sk === 'EXECUTION_PROFILE#device')) {
      revoked = true; await repo.kv.put({ pk: 'PROJECT#p', sk: 'EXECUTION_PROFILE#device', enabled: false, version: 1 });
    }
    return transaction(writes);
  };
  await expect(phase === 'barrier' ? broker.barrier(token('lead'), 0) :
    broker.state(token('lead'), { phase: 'RUNNING', ready: true, replica: 0 })).rejects.toMatchObject({ status: 409 });
  expect((await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#')).every(row => row.processStarted === false)).toBe(true);
  if (phase === 'barrier') expect((await repo.kv.get('WF#run', 'RUNTIME#epoch#META'))?.released).not.toBe(true);
});
it('binds capability identity and rejects signature tampering, expired tokens and changed project/attempt', async () => {
  const signed = token('lead');
  expect((await broker.authenticate(signed)).claims).toMatchObject({
    workflowId: 'run',
    projectId: 'p',
    namespace: 'team',
    task: 'lead',
    epoch: 'epoch',
    attempt: 1
  });
  await expect(broker.authenticate(signed.slice(0, -8) + 'tampered')).rejects.toMatchObject({
    status: 401
  });
  const original = (await repo.listTasks('run')).find(t => t.name === 'lead')!;
  await repo.putTask({
    ...original,
    attempts: 2,
    attemptEpoch: 'next'
  });
  await expect(broker.authenticate(signed)).rejects.toMatchObject({
    status: 410
  });
  await repo.putTask(original);
  await repo.putWorkflow({
    ...wf,
    projectId: 'other'
  });
  await expect(broker.authenticate(signed)).rejects.toMatchObject({
    status: 410
  });
  await repo.putWorkflow(wf);
  clock = new Date(clock.getTime() + 9 * 86400_000);
  await expect(broker.authenticate(signed)).rejects.toMatchObject({
    status: 410
  });
});
it('deduplicates ready reports and releases only after every declared replica is ready', async () => {
  const a = token('lead'),
    b = token('worker');
  await broker.state(a, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  });
  await broker.state(b, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  });
  await broker.state(b, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  });
  expect(await broker.barrier(a, 0)).toMatchObject({
    released: false,
    stopped: false
  });
  await expect(broker.state(b, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 2
  })).rejects.toMatchObject({
    status: 400
  });
  await broker.state(b, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 1
  });
  expect(await broker.barrier(a, 0)).toMatchObject({
    released: true
  });
  expect((await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#')).length).toBe(3);
});
it('does not allow RUNNING before barrier release and preserves terminal results against stale reports', async () => {
  const a = token('lead');
  await expect(broker.state(a, {
    phase: 'RUNNING',
    ready: true,
    replica: 0
  })).rejects.toMatchObject({
    status: 409
  });
  await broker.state(a, {
    phase: 'FAILED',
    ready: false,
    replica: 0,
    exitCode: 3
  });
  await broker.state(a, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  });
  const observed = await broker.observe(wf, 'pair', 'epoch', new AbortController().signal);
  expect(observed.tasks.lead).toMatchObject({
    phase: 'FAILED',
    exitCode: 3
  });
  expect(observed.barrierReleased).toBe(false);
  expect(await broker.barrier(token('worker'), 0)).toMatchObject({
    released: false,
    stopped: true
  });
});
it('keeps raw nonleader failure while honoring leader termination policy', async () => {
  const a = token('lead'),
    b = token('worker');
  for (const [t, replica] of [[a, 0], [b, 0], [b, 1]] as const) await broker.state(t, {
    phase: 'INITIALIZING',
    ready: true,
    replica
  });
  await broker.barrier(a, 0);
  await broker.state(a, {
    phase: 'RUNNING',
    ready: true,
    replica: 0
  });
  await broker.state(b, {
    phase: 'FAILED',
    ready: false,
    replica: 0,
    exitCode: 7
  });
  expect(await broker.barrier(a, 0)).toMatchObject({
    released: true,
    stopped: false
  });
  await broker.state(a, {
    phase: 'SUCCEEDED',
    ready: false,
    replica: 0,
    exitCode: 0
  });
  expect(await broker.barrier(b, 1)).toMatchObject({
    released: true,
    stopped: true
  });
  expect((await broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).tasks.worker).toMatchObject({
    phase: 'FAILED',
    exitCode: 7
  });
});
it('fencing revokes state, heartbeat and barrier requests and cannot fence a newer epoch', async () => {
  const signed = token('lead');
  await broker.fence(wf, 'pair', 'epoch', new AbortController().signal);
  await expect(broker.heartbeat(signed)).rejects.toMatchObject({
    status: 410
  });
  await expect(broker.state(signed, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  })).rejects.toMatchObject({
    status: 410
  });
  await expect(broker.barrier(signed, 0)).rejects.toMatchObject({
    status: 410
  });
  for (const t of await repo.listTasks('run')) await repo.putTask({
    ...t,
    attempts: 2,
    attemptEpoch: 'next'
  });
  await broker.fence(wf, 'pair', 'epoch', new AbortController().signal);
  const fresh = broker.environment(wf, wf.spec.workflow.tasks[0], 'next', 2).PAI_RUNTIME_TOKEN;
  await expect(broker.heartbeat(fresh)).resolves.toBeUndefined();
});
it('transaction fencing wins a race after authentication but before a participant write', async () => {
  const signed = token('lead'),
    tx = repo.kv.transaction.bind(repo.kv);
  let injected = false;
  repo.kv.transaction = async writes => {
    if (!injected && writes.some(w => w.kind === 'put' && w.item.sk.includes('#MEMBER#'))) {
      injected = true;
      await repo.kv.put({
        pk: 'WF#run',
        sk: 'FENCE#epoch',
        epoch: 'epoch'
      });
    }
    return tx(writes);
  };
  await expect(broker.state(signed, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  })).rejects.toMatchObject({
    status: 410
  });
  expect(await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#')).toEqual([]);
});
it('aggregates all replica exit policies without early completion or masking a failing replica', async () => {
  wf.spec.workflow.groups![0].tasks.find(t => t.name === 'worker')!.exitActions = {
    COMPLETE: '16',
    FAIL: '17'
  };
  wf.spec.workflow.tasks.find(t => t.name === 'worker')!.exitActions = {
    COMPLETE: '16',
    FAIL: '17'
  };
  await repo.putWorkflow(wf);
  const a = token('lead'),
    b = token('worker');
  for (const [t, replica] of [[a, 0], [b, 0], [b, 1]] as const) await broker.state(t, {
    phase: 'INITIALIZING',
    ready: true,
    replica
  });
  await broker.barrier(a, 0);
  for (const replica of [0, 1]) await broker.state(b, {
    phase: 'RUNNING',
    ready: true,
    replica
  });
  await broker.state(b, {
    phase: 'FAILED',
    ready: false,
    replica: 0,
    exitCode: 16
  });
  expect((await broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).tasks.worker).toMatchObject({
    phase: 'RUNNING'
  });
  await broker.state(b, {
    phase: 'FAILED',
    ready: false,
    replica: 1,
    exitCode: 17
  });
  expect((await broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).tasks.worker).toMatchObject({
    phase: 'FAILED',
    exitCode: 17
  });
});
it('treats runtime/checkpoint failures as group failure even with ignoreNonleadStatus and COMPLETE exit policy', async () => {
  const a = token('lead'),
    b = token('worker');
  for (const [t, replica] of [[a, 0], [b, 0], [b, 1]] as const) await broker.state(t, {
    phase: 'INITIALIZING',
    ready: true,
    replica
  });
  await broker.barrier(a, 0);
  await broker.state(b, {
    phase: 'RUNNING',
    ready: true,
    replica: 0
  });
  await broker.state(b, {
    phase: 'FAILED',
    ready: false,
    replica: 0,
    exitCode: 0,
    message: 'runtime-error: final checkpoint failed'
  });
  expect((await broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).tasks.lead).toMatchObject({
    phase: 'FAILED'
  });
  expect(await broker.barrier(a, 0)).toMatchObject({
    stopped: true
  });
});
it('supports disabled group barrier but still requires each participant preparation', async () => {
  wf.spec.workflow.groups![0].barrier = false;
  await repo.putWorkflow(wf);
  const a = token('lead'),
    b = token('worker');
  expect(await broker.barrier(a, 0)).toMatchObject({
    released: false
  });
  await broker.state(a, {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  });
  expect(await broker.barrier(a, 0)).toMatchObject({
    released: true
  });
  expect(await broker.barrier(b, 0)).toMatchObject({
    released: false
  });
});
it('does not report an active group after workflow cancellation even without a fence row', async () => {
  await repo.putWorkflow({
    ...wf,
    status: 'CANCELLED'
  });
  await expect(broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).rejects.toMatchObject({
    status: 410
  });
});
it('separates metrics from runtime audiences while applying the same active epoch checks', async () => {
  const task = wf.spec.workflow.tasks[0];
  const metrics = broker.mintMetricsCapability(wf, task, 'epoch', 1),
    runtime = token(task.name);
  expect((await broker.validateMetricsCapability(metrics)).claims.aud).toBe('pai-mlflow');
  await expect(broker.authenticate(metrics)).rejects.toMatchObject({
    status: 401
  });
  await expect(broker.validateMetricsCapability(runtime)).rejects.toMatchObject({
    status: 401
  });
  expect(Object.keys(broker.environment(wf, task, 'epoch', 1)).sort()).toEqual(['PAI_RUNTIME_ENDPOINT', 'PAI_RUNTIME_TOKEN']);
  await broker.fence(wf, 'pair', 'epoch', new AbortController().signal);
  await expect(broker.validateMetricsCapability(metrics)).rejects.toMatchObject({
    status: 410
  });
});
it('retains coordinated nonleader stop evidence without failing a successful group decision', async () => {
  wf.spec.workflow.groups![0].ignoreNonleadStatus = false;
  await repo.putWorkflow(wf);
  const a = token('lead'),
    b = token('worker');
  for (const [t, replica] of [[a, 0], [b, 0], [b, 1]] as const) await broker.state(t, {
    phase: 'INITIALIZING',
    ready: true,
    replica
  });
  await broker.barrier(a, 0);
  for (const [t, replica] of [[a, 0], [b, 0], [b, 1]] as const) await broker.state(t, {
    phase: 'RUNNING',
    ready: true,
    replica
  });
  await broker.state(a, {
    phase: 'SUCCEEDED',
    ready: false,
    replica: 0,
    exitCode: 0
  });
  for (const replica of [0, 1]) await broker.state(b, {
    phase: 'FAILED',
    ready: false,
    replica,
    exitCode: 143,
    message: 'group-stopped: observed exit preserved'
  });
  expect((await broker.observe(wf, 'pair', 'epoch', new AbortController().signal)).tasks.worker.phase).toBe('SUCCEEDED');
  const rows = await repo.kv.query('WF#run', 'RUNTIME#epoch#MEMBER#worker#');
  expect(rows.every(r => r.phase === 'FAILED' && r.exitCode === 143)).toBe(true);
});
