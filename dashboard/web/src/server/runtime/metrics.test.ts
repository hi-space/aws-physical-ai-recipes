import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import { mintMetricsCapability, validateMetricsCapability, validateRuntimeCapability, runtimeEnvironment } from './index';
let repo: Repo, wf: Workflow;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
  vi.stubEnv('RUNTIME_SIGNING_KEY', 's'.repeat(64));
  vi.stubEnv('RUNTIME_API_URL', 'http://worker');
  repo = new Repo(new MemoryKV());
  setRepoForTests(repo);
  const yaml = 'workflow:\n  name: metrics\n  mlflow: true\n  resources: {cpu: {cpu: 1}}\n  tasks: [{name: train, resource: cpu, image: busybox, command: [echo, ok]}]\n';
  wf = {
    id: 'run',
    name: 'metrics',
    namespace: 'team',
    projectId: 'p',
    owner: 'a',
    status: 'RUNNING',
    spec: parseWorkflowYaml(yaml).spec,
    specYaml: yaml,
    vars: {},
    createdAt: 'x',
    updatedAt: 'x',
    taskCount: 1,
    succeededCount: 0,
    failedCount: 0
  };
  await repo.putWorkflow(wf);
  await repo.putTask({
    workflowId: 'run',
    name: 'train',
    phase: 'RUNNING',
    attempts: 1,
    attemptEpoch: 'epoch',
    replicas: 1,
    updatedAt: 'x'
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setRepoForTests(new Repo(new MemoryKV()));
});
it('exports distinct metrics mint/validate APIs while preserving runtime audience defaults', async () => {
  const metrics = mintMetricsCapability(wf, wf.spec.workflow.tasks[0], 'epoch', 1);
  expect((await validateMetricsCapability(metrics)).claims).toMatchObject({
    aud: 'pai-mlflow',
    projectId: 'p',
    namespace: 'team',
    workflowId: 'run',
    task: 'train',
    epoch: 'epoch',
    attempt: 1
  });
  await expect(validateRuntimeCapability(metrics)).rejects.toMatchObject({
    status: 401
  });
  const control = runtimeEnvironment(wf, wf.spec.workflow.tasks[0], 'epoch', 1).PAI_RUNTIME_TOKEN;
  await expect(validateMetricsCapability(control)).rejects.toMatchObject({
    status: 401
  });
});
it('revokes metrics capabilities after project/attempt changes and expiry', async () => {
  const metrics = mintMetricsCapability(wf, wf.spec.workflow.tasks[0], 'epoch', 1);
  await repo.putWorkflow({
    ...wf,
    projectId: 'other'
  });
  await expect(validateMetricsCapability(metrics)).rejects.toMatchObject({
    status: 410
  });
  await repo.putWorkflow(wf);
  const task = (await repo.listTasks('run'))[0];
  await repo.putTask({
    ...task,
    attempts: 2,
    attemptEpoch: 'next'
  });
  await expect(validateMetricsCapability(metrics)).rejects.toMatchObject({
    status: 410
  });
  await repo.putTask(task);
  vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
  await expect(validateMetricsCapability(metrics)).rejects.toMatchObject({
    status: 410
  });
});
