import { expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Job, Pod } from '../k8s/resources';
import { submitWorkflow, retryWorkflow, reconcileWorkflow } from './controller';
import type { ControllerDeps, K8sPort } from './ports';
import type { RecoveryTask, RecoveryWorkflow } from './checkpoints';
import { parseWorkflowYaml } from './template';

const yaml = `workflow:
  name: checkpoint-retry
  resources: { cpu: { cpu: 1 } }
  tasks:
    - name: train
      resource: cpu
      image: python
      command: [python, train.py]
      checkpoint: [{path: '{{output}}', url: auto, frequency: 1s}]
      retry: {max_retries: 1, backoff_seconds: 1}
      exitActions: {COMPLETE: 0, RESCHEDULE: 75}
`;

function fixture() {
  const repo = new Repo(new MemoryKV());
  const jobs = new Map<string, Job>();
  const created: any[] = [];
  const secrets = new Map<string, Record<string, string>>();
  let pods: Pod[] = [];
  let clock = new Date('2026-09-16T00:00:00Z');
  const k8s: K8sPort = {
    getJob: async (_ns, name) => jobs.get(name) ?? null,
    listPods: async (_ns, selector) => pods.filter(p => selector.split(',').every(pair => {
      const [key, value] = pair.split('='); return p.metadata.labels?.[key] === value;
    })),
    createJob: async (_ns, object) => { const job = structuredClone(object) as Job; created.push(job); jobs.set(job.metadata.name, job); return job; },
    deleteJob: async (_ns, name) => { jobs.delete(name); pods = pods.filter(p => p.metadata.labels?.['job-name'] !== name); },
    ensureNamespace: async () => {}, ensureFsxPvc: async () => {},
    upsertConfigMap: async () => {}, upsertSecret: async (_ns, name, values) => { secrets.set(name, values); }, deleteByLabel: async () => {},
    queueState: async () => 'admitted',
  };
  const deps: ControllerDeps = { repo, k8s, now: () => clock, notify: async () => {}, resolveCredential: async () => '',
    runtimeImage: 'runtime:test', runtimeCommand: '/opt/pai/runtime', artifactBucket: 'artifacts',
    runtimeEnvironment: (_wf, _task, _epoch, attempt) => ({ PAI_RUNTIME_ENDPOINT: 'http://broker', PAI_RUNTIME_TOKEN: `token-${attempt}` }) };
  return { repo, jobs, created, secrets, deps, tick: () => { clock = new Date(clock.getTime() + 2000); },
    setPods: (value: Pod[]) => { pods = value; } };
}

const input = { yaml, owner: 'alice', ownerSubject: 'alice-id', projectId: 'p', namespace: 'hyperpod-ns-p', queue: 'project-queue' };

it('automatic RESCHEDULE persists the old attempt source and compiles restore using a new capability', async () => {
  const f = fixture();
  const workflow = await submitWorkflow(input, f.deps);
  const first = (await f.repo.listTasks(workflow.id))[0];
  await f.repo.putWorkflow({ ...workflow, status: 'RUNNING' });
  await f.repo.putTask({ ...first, phase: 'RUNNING' });
  f.jobs.get(first.jobName!)!.status = { conditions: [{ type: 'Failed', status: 'True' }] };
  f.setPods([{ metadata: { name: 'pod', labels: { 'job-name': first.jobName! } },
    spec: { containers: [] }, status: { phase: 'Failed', containerStatuses: [{ name: 'main', ready: false, restartCount: 0,
      state: { terminated: { exitCode: 75 } } }] } } as Pod]);
  await f.repo.kv.put({ pk: `WF#${workflow.id}`, sk: `RUNTIME#${first.attemptEpoch}#MEMBER#train#0`,
    task: 'train', replica: 0, phase: 'FAILED', exitCode: 75, processStarted: true, runtimeFailure: false });
  for (let i = 0; i < 8 && (await f.repo.listTasks(workflow.id))[0].attempts < 2; i++) {
    f.tick(); await reconcileWorkflow((await f.repo.getWorkflow(workflow.id))!, f.deps);
  }
  const second = (await f.repo.listTasks(workflow.id))[0] as RecoveryTask;
  expect(second.attempts).toBe(2);
  expect(second.attemptEpoch).not.toBe(first.attemptEpoch);
  expect(second.checkpointRestoreSources).toEqual([{ workflowId: workflow.id, task: 'train', attempt: 1, epoch: first.attemptEpoch }]);
  const container = f.created.at(-1).spec.template.spec.containers[0];
  expect(container.command.join(' ')).toContain('"checkpointRestore":true');
  const token = container.env.find((entry: { name: string }) => entry.name === 'PAI_RUNTIME_TOKEN');
  expect(token.value).toBeUndefined();
  expect(token.valueFrom.secretKeyRef.key).toBe('PAI_RUNTIME_TOKEN');
  expect(f.secrets.get(token.valueFrom.secretKeyRef.name)?.PAI_RUNTIME_TOKEN).toBe('token-2');
});

it('manual retry copies only server-owned checkpoint lineage in the same project', async () => {
  const f = fixture();
  f.deps.enqueueWorkflow = async () => {};
  const old = await submitWorkflow({ ...input, deferLaunch: true }, f.deps);
  await f.repo.putWorkflow({ ...old, status: 'FAILED' });
  await f.repo.putTask({ workflowId: old.id, name: 'train', phase: 'FAILED', attempts: 2, attemptEpoch: 'prior-epoch',
    replicas: 1, updatedAt: old.updatedAt });
  const retried = await retryWorkflow(old.id, 'alice', f.deps, { ownerSubject: 'alice-id' }) as RecoveryWorkflow;
  expect(retried.id).not.toBe(old.id);
  expect(retried.retryOf).toBe(old.id);
  expect(retried.projectId).toBe('p');
  expect((await f.repo.listTasks(retried.id))[0]).toMatchObject({
    attempts: 0, checkpointRestoreSources: [{ workflowId: old.id, task: 'train', attempt: 2, epoch: 'prior-epoch' }],
  });
  const ordinary = await submitWorkflow({ ...input, deferLaunch: true, retryOf: old.id, checkpointRestoreSources: [] } as any, f.deps) as RecoveryWorkflow;
  expect(ordinary.retryOf).toBeUndefined();
  expect(() => parseWorkflowYaml(yaml.replace('  name: checkpoint-retry', '  name: checkpoint-retry\n  retryOf: other'))).toThrow();
});
