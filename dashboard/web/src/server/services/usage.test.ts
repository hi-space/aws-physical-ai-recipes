import { describe, expect, it } from 'vitest';
import { estimateRunUsage, projectUsage, runUsage } from './usage';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Workflow, Task } from '../store/types';
import { parseWorkflowYaml } from '../workflow/template';

const start = '2026-09-16T10:00:00Z', end = '2026-09-16T11:00:00Z';
function fixture(gpu = false) {
  const parsed = parseWorkflowYaml(`workflow:\n  name: usage\n  resources: { r: { cpu: 8, gpu: ${gpu ? 1 : 0}, platform: ${gpu ? 'ml.g5.8xlarge' : 'ml.c5.4xlarge'} } }\n  tasks: [{name: train, resource: r, image: example:v1, command: [python, train.py], parallelism: 2}]`);
  const workflow = { id: 'run', projectId: 'p', owner: 'user', status: 'SUCCEEDED', spec: parsed.spec, createdAt: start, finishedAt: end } as Workflow;
  const task: Task = { workflowId: 'run', name: 'train', phase: 'SUCCEEDED', attempts: 1, replicas: 2, startedAt: start, finishedAt: end, updatedAt: end };
  return { workflow, task };
}
describe('requested resource-hour estimates', () => {
  it('counts replicas without exposing any priced amount', () => {
    const { workflow, task } = fixture(true);
    const result = estimateRunUsage(workflow, [task], [], new Date(end));
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(2);
    expect((result as Record<string, unknown>).estimatedUsd).toBeUndefined();
    expect((result as Record<string, unknown>).pricing).toBeUndefined();
  });
  it('reports CPU-only resource requests the same way', () => {
    const { workflow, task } = fixture();
    const result = estimateRunUsage(workflow, [task], [], new Date(end));
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(0);
  });
  it('recovers previous attempts from runtime epochs instead of counting only the last retry', () => {
    const { workflow, task } = fixture();
    task.attempts = 2; task.replicas = 1; workflow.spec.workflow.tasks[0].parallelism = 1;
    const rows = ['old', 'new'].flatMap(epoch => [
      { pk: 'WF#run', sk: `RUNTIME#${epoch}#META`, releasedAt: start },
      { pk: 'WF#run', sk: `RUNTIME#${epoch}#MEMBER#train#0`, task: 'train', replica: 0, processStarted: true, phase: 'SUCCEEDED', updatedAt: end },
    ]);
    const result = estimateRunUsage(workflow, [task], rows, new Date(end));
    expect(result.cpuHours).toBe(16); expect(result.tasks[0].attemptsObserved).toBe(2); expect(result.complete).toBe(true);
  });
  it('removes estimated costs when rates are unavailable', () => {
    const { workflow } = fixture();
    // no matching task ledger for the "train" task spec
    const result = estimateRunUsage(workflow, [], [], new Date(end));
    expect((result as Record<string, unknown>).estimatedUsd).toBeUndefined();
    expect(result.cpuHours).toBeDefined();
    expect(result.gpuHours).toBeDefined();
    expect(result.issues).toContainEqual({ task: 'train', code: 'missing_ledger' });
  });
  it('does not return rate details in task usage', () => {
    const { workflow, task } = fixture();
    const result = estimateRunUsage(workflow, [task], [], new Date(end));
    expect((result.tasks[0] as unknown as Record<string, unknown>).rate).toBeUndefined();
    expect(result.tasks[0].cpuHours).toBeDefined();
  });
  it('marks missing retry history and incomplete replica reports as unknown', () => {
    const { workflow, task } = fixture();
    task.attempts = 2;
    let result = estimateRunUsage(workflow, [task], [], new Date(end));
    expect(result.complete).toBe(false); expect(result.cpuHours).toBeNull(); expect(result.knownCpuHours).toBe(16);
    task.attempts = 1; delete workflow.spec.workflow.resources.r.platform;
    result = estimateRunUsage(workflow, [task], [], new Date(end));
    expect(result.cpuHours).toBe(16);
  });
  it('does not invent compute time for queued work or a terminal task with missing timing', () => {
    const { workflow, task } = fixture();
    task.phase = 'WAITING'; task.attempts = 0; delete task.startedAt; delete task.finishedAt;
    expect(estimateRunUsage(workflow, [task], [], new Date(end)).cpuHours).toBe(0);
    task.phase = 'FAILED'; task.attempts = 1;
    expect(estimateRunUsage(workflow, [task], [], new Date(end)).cpuHours).toBeNull();
  });
  it('authorizes project/run estimates and aggregates only the requested project, preserving unknown coverage', async () => {
    const repo = new Repo(new MemoryKV()), { workflow, task } = fixture();
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', id: 'p', name: 'P' });
    await repo.kv.put({ pk: 'PROJECT#q', sk: 'META', id: 'q', name: 'Q' });
    await repo.putWorkflow({ ...workflow, id: 'run', projectId: 'p', namespace: 'ns', owner: 'alice', vars: {}, specYaml: '', taskCount: 1, succeededCount: 1, failedCount: 0, updatedAt: end });
    await repo.putTask(task);
    await repo.putWorkflow({ ...workflow, id: 'private', projectId: 'q', namespace: 'other', owner: 'bob', vars: {}, specYaml: '', taskCount: 1, succeededCount: 1, failedCount: 0, updatedAt: end });
    const alice = { user: 'alice', subject: 'alice', email: '', role: 'viewer' as const, groups: ['viewers', 'proj-p'] };
    await expect(runUsage('private', alice, repo, () => new Date(end))).rejects.toMatchObject({ status: 404 });
    await expect(projectUsage('q', alice, repo, () => new Date(end))).rejects.toMatchObject({ status: 403 });
    const result = await projectUsage('p', alice, repo, () => new Date(end));
    expect(result.runs.map(run => run.workflowId)).toEqual(['run']);
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(0);
  });
});
