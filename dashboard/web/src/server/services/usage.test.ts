import { describe, expect, it } from 'vitest';
import { estimateRunUsage, projectUsage, runUsage } from './usage';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Workflow, Task } from '../store/types';
import type { RateSnapshot } from '../aws/hyperpod-rates';
import { parseWorkflowYaml } from '../workflow/template';

const start = '2026-09-16T10:00:00Z', end = '2026-09-16T11:00:00Z';
const prices: RateSnapshot = { service: 'AmazonSageMaker', region: 'us-east-1', currency: 'USD', term: 'OnDemand', sourceUrl: 'https://pricing.us-east-1.amazonaws.com/official.json',
  retrievedAt: end, publicationDate: start, catalogVersion: '1', sha256: 'a'.repeat(64), rates: [
    { instanceType: 'ml.c5.4xlarge', region: 'us-east-1', usdPerHour: 0.816, vCpu: 16, gpu: 0, sku: 'cpu-sku', rateCode: 'cpu-rate', effectiveDate: start },
    { instanceType: 'ml.g5.8xlarge', region: 'us-east-1', usdPerHour: 3.06, vCpu: 32, gpu: 1, sku: 'gpu-sku', rateCode: 'gpu-rate', effectiveDate: start },
  ] };
function fixture(gpu = false) {
  const parsed = parseWorkflowYaml(`workflow:\n  name: usage\n  resources: { r: { cpu: 8, gpu: ${gpu ? 1 : 0}, platform: ${gpu ? 'ml.g5.8xlarge' : 'ml.c5.4xlarge'} } }\n  tasks: [{name: train, resource: r, image: example:v1, command: [python, train.py], parallelism: 2}]`);
  const workflow = { id: 'run', projectId: 'p', owner: 'user', status: 'SUCCEEDED', spec: parsed.spec, createdAt: start, finishedAt: end } as Workflow;
  const task: Task = { workflowId: 'run', name: 'train', phase: 'SUCCEEDED', attempts: 1, replicas: 2, startedAt: start, finishedAt: end, updatedAt: end };
  return { workflow, task };
}
describe('requested resource-hour estimates', () => {
  it('counts replicas and dominant CPU/GPU share without charging both parts of the same instance twice', () => {
    const { workflow, task } = fixture(true);
    const result = estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1');
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(2); expect(result.estimatedUsd).toBe(6.12);
    expect(result.tasks[0].rate?.sku).toBe('gpu-sku');
    expect(result.pricing.retrievedAt).toBe(end);
  });
  it('provides a CPU share estimate and separately exposes dedicated-instance budget assumptions', () => {
    const { workflow, task } = fixture();
    const result = estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1');
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(0);
    expect(result.estimatedUsd).toBe(0.816); expect(result.dedicatedInstanceUsd).toBe(1.632);
  });
  it('recovers previous attempts from runtime epochs instead of counting only the last retry', () => {
    const { workflow, task } = fixture();
    task.attempts = 2; task.replicas = 1; workflow.spec.workflow.tasks[0].parallelism = 1;
    const rows = ['old', 'new'].flatMap(epoch => [
      { pk: 'WF#run', sk: `RUNTIME#${epoch}#META`, releasedAt: start },
      { pk: 'WF#run', sk: `RUNTIME#${epoch}#MEMBER#train#0`, task: 'train', replica: 0, processStarted: true, phase: 'SUCCEEDED', updatedAt: end },
    ]);
    const result = estimateRunUsage(workflow, [task], rows, prices, new Date(end), 'us-east-1');
    expect(result.cpuHours).toBe(16); expect(result.tasks[0].attemptsObserved).toBe(2); expect(result.complete).toBe(true);
  });
  it('marks missing retry history, unknown platform, expired pricing and incomplete replica reports as unknown', () => {
    const { workflow, task } = fixture();
    task.attempts = 2;
    let result = estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1');
    expect(result.complete).toBe(false); expect(result.cpuHours).toBeNull(); expect(result.knownCpuHours).toBe(16);
    task.attempts = 1; delete workflow.spec.workflow.resources.r.platform;
    result = estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1');
    expect(result.cpuHours).toBe(16); expect(result.estimatedUsd).toBeNull();
    result = estimateRunUsage(fixture().workflow, [task], [], prices, new Date('2026-11-16T00:00:00Z'), 'us-east-1');
    expect(result.estimatedUsd).toBeNull(); expect(result.issues.some(i => i.code === 'stale_rates')).toBe(true);
  });
  it('does not invent compute time for queued work or a terminal task with missing timing', () => {
    const { workflow, task } = fixture();
    task.phase = 'WAITING'; task.attempts = 0; delete task.startedAt; delete task.finishedAt;
    expect(estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1').cpuHours).toBe(0);
    task.phase = 'FAILED'; task.attempts = 1;
    expect(estimateRunUsage(workflow, [task], [], prices, new Date(end), 'us-east-1').cpuHours).toBeNull();
  });
  it('authorizes project/run estimates and aggregates only the requested project, preserving unknown coverage', async () => {
    const repo = new Repo(new MemoryKV()), { workflow, task } = fixture();
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', id: 'p', name: 'P', members: { alice: 'viewer' } });
    await repo.kv.put({ pk: 'PROJECT#q', sk: 'META', id: 'q', name: 'Q', members: { bob: 'viewer' } });
    await repo.putWorkflow({ ...workflow, id: 'run', projectId: 'p', namespace: 'ns', owner: 'alice', vars: {}, specYaml: '', taskCount: 1, succeededCount: 1, failedCount: 0, updatedAt: end });
    await repo.putTask(task);
    await repo.putWorkflow({ ...workflow, id: 'private', projectId: 'q', namespace: 'other', owner: 'bob', vars: {}, specYaml: '', taskCount: 1, succeededCount: 1, failedCount: 0, updatedAt: end });
    await repo.kv.put({ pk: 'USAGE_PRICING#us-east-1', sk: 'CURRENT', snapshot: prices, revision: 1 });
    const alice = { user: 'alice', subject: 'alice', email: '', role: 'viewer' as const };
    await expect(runUsage('private', alice, repo, prices, () => new Date(end))).rejects.toMatchObject({ status: 404 });
    await expect(projectUsage('q', alice, repo, () => new Date(end))).rejects.toMatchObject({ status: 403 });
    const result = await projectUsage('p', alice, repo, () => new Date(end));
    expect(result.runs.map(run => run.workflowId)).toEqual(['run']);
    expect(result.cpuHours).toBe(16); expect(result.gpuHours).toBe(0);
  });
});
