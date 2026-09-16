import { expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Task, Workflow } from '../store/types';
import { parseWorkflowYaml } from './template';
import { reconcileWorkflow } from './controller';
import type { ControllerDeps, K8sPort } from './ports';

async function fixture(target: NonNullable<Task['cleanupTarget']>, phase: Task['phase'] = 'CANCELLING', grouped = false) {
  const repo = new Repo(new MemoryKV());
  const now = '2026-09-16T00:00:00Z';
  const yaml = grouped ? `workflow:
  name: collector-group
  resources: {cpu: {cpu: 1}}
  groups:
    - name: workers
      tasks:
        - {name: lead, lead: true, resource: cpu, image: busybox, command: [echo, done]}
        - {name: peer, resource: cpu, image: busybox, command: [echo, done]}
` : `workflow:
  name: collector
  resources: {cpu: {cpu: 1}}
  tasks:
    - name: produce
      resource: cpu
      image: busybox
      command: [echo, done]
      exitActions: {COMPLETE: 7}
      outputs: [{logs: '{{output}}/artifact'}]
`;
  const wf: Workflow = { id: 'run', name: 'collector', owner: 'alice', projectId: 'p', namespace: 'n',
    status: 'RUNNING', spec: parseWorkflowYaml(yaml).spec, specYaml: yaml, vars: {},
    createdAt: now, updatedAt: now, taskCount: grouped ? 2 : 1, succeededCount: 0, failedCount: 0 };
  await repo.putWorkflow(wf);
  for (const spec of wf.spec.workflow.tasks) await repo.putTask({
    workflowId: wf.id, name: spec.name, groupId: spec.group, phase, cleanupTarget: target,
    attempts: 4, attemptEpoch: 'epoch-4', replicas: 1, exitCode: 7, wrapperExitCode: 0,
    outputPath: `/fsx/checkpoints/projects/p/runs/run/attempts/4/${spec.name}`,
    nextRetryAt: '2026-09-16T01:00:00Z', updatedAt: now,
    // The original workload Job may already be gone while a collector remains.
  });
  const k8s: K8sPort = {
    getJob: async () => null, listPods: async () => [], createJob: async () => { throw new Error('unexpected workload create'); },
    deleteJob: async () => {}, ensureNamespace: async () => {}, ensureFsxPvc: async () => {},
    upsertConfigMap: async () => {}, upsertSecret: async () => {}, deleteByLabel: async () => {},
    queueState: async () => 'unknown',
  };
  const deps: ControllerDeps = { repo, k8s, now: () => new Date(now), notify: async () => {}, resolveCredential: async () => '',
    groupRuntime: { fence: async () => {}, observe: async () => ({ epoch: 'epoch-4', barrierReleased: true, tasks: {} }) } };
  return { repo, wf, deps, now };
}

it('cancellation waits for collector Job and Pod deletion even without an original workload jobName', async () => {
  const f = await fixture('SUCCEEDED', 'FINALIZING');
  await f.repo.requestCancellation(f.wf.id, 'alice', f.now);
  let jobGone = false, podGone = false;
  const contexts: { taskNames?: string[]; attempt?: number; signalAborted: boolean; workflowId: string }[] = [];
  f.deps.cancelArtifacts = async (wf, context) => {
    contexts.push({ taskNames: context.taskNames, attempt: context.attempt, signalAborted: context.signal.aborted, workflowId: wf.id });
    return jobGone && podGone;
  };
  expect((await reconcileWorkflow(f.wf, f.deps)).status).toBe('CANCELLING');
  expect((await f.repo.listTasks(f.wf.id))[0].phase).toBe('CANCELLING');
  expect(contexts[0]).toEqual({ taskNames: ['produce'], attempt: 4, signalAborted: false, workflowId: 'run' });
  jobGone = true;
  expect((await reconcileWorkflow((await f.repo.getWorkflow('run'))!, f.deps)).status).toBe('CANCELLING');
  podGone = true;
  expect((await reconcileWorkflow((await f.repo.getWorkflow('run'))!, f.deps)).status).toBe('CANCELLED');
});

it.each(['FAILED', 'RETRY_WAIT'] as const)('%s cleanup does not advance while artifact cancellation is pending', async target => {
  const f = await fixture(target);
  let gone = false;
  f.deps.cancelArtifacts = async () => gone;
  await reconcileWorkflow(f.wf, f.deps);
  expect((await f.repo.listTasks('run'))[0].phase).toBe('CANCELLING');
  gone = true;
  await reconcileWorkflow((await f.repo.getWorkflow('run'))!, f.deps);
  expect((await f.repo.listTasks('run'))[0].phase).toBe(target);
});

it('does not fence collectors on COMPLETE success or prevent legitimate FINALIZING publication', async () => {
  const f = await fixture('SUCCEEDED');
  let collectorGone = false, cancellations = 0;
  f.deps.cancelArtifacts = async () => { cancellations++; throw new Error('successful publication must not be fenced'); };
  f.deps.artifactPublisher = {
    publish: async () => collectorGone ? { state: 'ready',
      uri: 's3://artifacts/projects/p/result/', manifestUri: 's3://artifacts/projects/p/result/manifest.json',
      manifestHash: 'a'.repeat(64), verifiedAt: f.now, objectCount: 1, sizeBytes: 3,
    } : { state: 'pending', message: 'collector still running' },
  };
  expect((await reconcileWorkflow(f.wf, f.deps)).status).toBe('FINALIZING');
  expect((await f.repo.listTasks('run'))[0]).toMatchObject({ phase: 'FINALIZING', exitCode: 7, wrapperExitCode: 0 });
  collectorGone = true;
  expect((await reconcileWorkflow((await f.repo.getWorkflow('run'))!, f.deps)).status).toBe('SUCCEEDED');
  expect(cancellations).toBe(0);
});

it('passes exact grouped task names and attempt to artifact cancellation', async () => {
  const f = await fixture('FAILED', 'CANCELLING', true);
  const names: string[][] = [];
  f.deps.cancelArtifacts = async (_wf, context) => {
    expect(context.attempt).toBe(4);
    names.push(context.taskNames!);
    return false;
  };
  await reconcileWorkflow(f.wf, f.deps);
  expect(names[0]).toEqual(['lead', 'peer']);
  expect((await f.repo.listTasks('run')).every(task => task.phase === 'CANCELLING')).toBe(true);
});

it('surfaces collector cleanup errors without fabricating completed cancellation', async () => {
  const f = await fixture('CANCELLED');
  await f.repo.requestCancellation('run', 'alice', f.now);
  f.deps.cancelArtifacts = async () => { throw new Error('collector deletion unavailable'); };
  expect((await reconcileWorkflow(f.wf, f.deps)).status).toBe('CANCELLING');
  expect((await f.repo.listTasks('run'))[0]).toMatchObject({ phase: 'CANCELLING', message: 'collector deletion unavailable' });
});
