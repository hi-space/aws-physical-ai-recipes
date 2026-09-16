import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { RuntimeBroker } from '../runtime/broker';
import type { Job, Pod } from '../k8s/resources';
import type { Workflow } from '../store/types';
import { compileTask } from './compile';
import { parseWorkflowYaml } from './template';
import { reconcileWorkflow, submitWorkflow, type ControllerDeps, type K8sPort } from './controller';

class ReviewCluster implements K8sPort {
  jobs = new Map<string, Job>();
  pods: Pod[] = [];
  secrets = new Map<string, Record<string, string>>();
  async ensureNamespace() {}
  async ensureFsxPvc() {}
  async upsertConfigMap() {}
  async upsertSecret(_ns: string, name: string, data: Record<string, string>) { this.secrets.set(name, data); }
  async deleteByLabel() {}
  async queueState() { return 'admitted' as const; }
  async getJob(_ns: string, name: string) { return this.jobs.get(name) ?? null; }
  async listPods(_ns: string, selector: string) {
    return this.pods.filter(pod => selector.split(',').every(pair => {
      const [key, value] = pair.split('=');
      return pod.metadata.labels?.[key] === value;
    }));
  }
  async createJob(_ns: string, body: unknown) {
    const job = structuredClone(body as Job);
    job.metadata.uid = `uid-${job.metadata.name}`;
    this.jobs.set(job.metadata.name, job);
  }
  async deleteJob(_ns: string, name: string) {
    this.jobs.delete(name);
    this.pods = this.pods.filter(pod => pod.metadata.labels?.['job-name'] !== name);
  }
  finish(name: string, wrapperExit: number) {
    const job = this.jobs.get(name)!;
    job.spec.suspend = false;
    job.status = { conditions: [{ type: wrapperExit === 0 ? 'Complete' : 'Failed', status: 'True' }] };
    this.pods = [{
      metadata: { name: `${name}-pod`, labels: { 'job-name': name } },
      spec: { containers: [] },
      status: {
        phase: wrapperExit === 0 ? 'Succeeded' : 'Failed',
        containerStatuses: [{ name: 'main', ready: false, restartCount: 0, state: { terminated: { exitCode: wrapperExit } } }],
      },
    }];
  }
}

const yaml = `workflow:
  name: review
  resources: { cpu: { cpu: 1 } }
  tasks:
    - name: train
      resource: cpu
      image: busybox
      command: [echo, ok]
      exitActions: { COMPLETE: "0-255" }
`;
let repo: Repo, cluster: ReviewCluster, broker: RuntimeBroker, deps: ControllerDeps;
beforeEach(() => {
  repo = new Repo(new MemoryKV());
  cluster = new ReviewCluster();
  const now = () => new Date('2026-09-16T00:00:00Z');
  broker = new RuntimeBroker({ repo, now, signingKey: 'fixture-key'.repeat(8), apiUrl: 'http://runtime', artifactBucket: 'artifacts' });
  deps = {
    repo, k8s: cluster, now, notify: async () => {}, resolveCredential: async () => '',
    runtimeImage: 'trusted/runtime:fixed',
    runtimeEnvironment: (wf, task, epoch, attempt) => broker.environment(wf, task, epoch, attempt),
  };
});
const submit = (text = yaml) => submitWorkflow({ yaml: text, owner: 'alice', projectId: 'p', namespace: 'team', queue: 'q' }, deps);
async function report(wf: Workflow, exitCode: number, message: string) {
  const task = (await repo.listTasks(wf.id))[0];
  const token = broker.environment(wf, wf.spec.workflow.tasks[0], task.attemptEpoch!, task.attempts).PAI_RUNTIME_TOKEN;
  await broker.state(token, { phase: 'INITIALIZING', ready: true, replica: 0 });
  await broker.barrier(token, 0);
  await broker.state(token, { phase: 'RUNNING', ready: true, replica: 0 });
  await broker.state(token, { phase: exitCode === 0 && !message.startsWith('runtime-error:') ? 'SUCCEEDED' : 'FAILED', ready: false, replica: 0, exitCode, message });
  return task;
}

describe('review finding 1: standalone runtime outcomes', () => {
  it.each([
    { checkpoint: true, applicationExit: 0, message: 'runtime-error: final checkpoint failed' },
    { checkpoint: true, applicationExit: 16, message: 'runtime-error: final checkpoint failed' },
    { checkpoint: false, applicationExit: 0, message: 'runtime-error: control connection failed' },
  ])('cannot turn wrapper exit 125 into success with COMPLETE 0-255 ($message, checkpoint=$checkpoint)', async test => {
    const wf = await submit(yaml + (test.checkpoint ? '      checkpoint: [{path: /tmp/checkpoints, url: "s3://artifacts/projects/p/checkpoints/", frequency: 30s}]\n' : ''));
    const task = await report(wf, test.applicationExit, test.message);
    const records = await repo.kv.query(`WF#${wf.id}`, `RUNTIME#${task.attemptEpoch}#MEMBER#train#`);
    expect(records[0]).toMatchObject({ phase: 'FAILED', runtimeFailure: true, exitCode: test.applicationExit });
    cluster.finish(task.jobName!, 125);
    expect((await reconcileWorkflow(wf, deps)).status).toBe('FAILED');
    expect((await repo.listTasks(wf.id))[0]).toMatchObject({ phase: 'FAILED', exitCode: test.applicationExit, runtimeFailure: true });
  });
  it.each([16, 125])('still permits an actual application exit %s normalized by COMPLETE', async applicationExit => {
    const wf = await submit();
    const task = await report(wf, applicationExit, 'action=COMPLETE');
    cluster.finish(task.jobName!, 0);
    expect((await reconcileWorkflow(wf, deps)).status).toBe('SUCCEEDED');
    expect((await repo.listTasks(wf.id))[0].exitCode).toBe(applicationExit);
  });
  it('applies RESCHEDULE to the original application zero rather than the normalized wrapper 75', async () => {
    const wf = await submit(yaml.replace('COMPLETE: "0-255"', 'COMPLETE: "1-255", RESCHEDULE: "0"') + '      retry: {max_retries: 1, backoff_seconds: 10}\n');
    const task = await report(wf, 0, 'action=RESCHEDULE');
    cluster.finish(task.jobName!, 75);
    expect((await reconcileWorkflow(wf, deps)).status).toBe('RUNNING');
    expect((await repo.listTasks(wf.id))[0]).toMatchObject({ phase: 'RETRY_WAIT', exitCode: 0 });
  });
  it('requires current unfenced terminal runtime evidence even if the Job reports success', async () => {
    const wf = await submit();
    const task = await report(wf, 0, 'action=COMPLETE');
    cluster.finish(task.jobName!, 0);
    await repo.kv.put({ pk: `WF#${wf.id}`, sk: `FENCE#${task.attemptEpoch}` });
    expect((await reconcileWorkflow(wf, deps)).status).not.toBe('SUCCEEDED');
  });
  it('cannot complete from a previous epoch or absent runtime reports', async () => {
    const wf = await submit();
    const task = (await repo.listTasks(wf.id))[0];
    await repo.kv.put({ pk: `WF#${wf.id}`, sk: 'RUNTIME#old#MEMBER#train#0', task: 'train', replica: 0, phase: 'SUCCEEDED', exitCode: 0, processStarted: true });
    cluster.finish(task.jobName!, 0);
    expect((await reconcileWorkflow(wf, deps)).status).not.toBe('SUCCEEDED');
  });
});

describe('review finding 2: indexed dataset bindings', () => {
  it.each([false, true])('keeps data v1/v2 paths, mounts and provenance distinct (aliases=$0)', async aliases => {
    await repo.putDataset({ name: 'data', projectId: 'p', owner: 'alice', latestVersion: 2, tags: [], createdAt: 'x', updatedAt: 'x' });
    for (const version of [1, 2]) await repo.putVersion({
      dataset: 'data', projectId: 'p', version, uri: `s3://artifacts/projects/p/data/v${version}/`,
      fsxPath: `/fsx/datasets/projects/p/data/v${version}`, manifestHash: String(version).repeat(64),
      state: 'READY', tags: [], createdAt: 'x', createdBy: 'alice',
    });
    const inputs = `      inputs:\n        - dataset: {name: data, version: 1${aliases ? ', path: /first' : ''}}\n        - dataset: {name: data, version: 2${aliases ? ', path: /second' : ''}}\n`;
    const wf = await submit(yaml.replace('command: [echo, ok]', 'command: [cat, "{{input:0}}/a", "{{input:1}}/b"]') + inputs);
    const task = (await repo.listTasks(wf.id))[0];
    const job = cluster.jobs.get(task.jobName!)!;
    const pod = job.spec.template.spec as Omit<typeof job.spec.template.spec, 'initContainers'> & { initContainers: { name: string; command?: string[] }[] };
    const main = pod.containers[0];
    expect(wf.spec.workflow.tasks[0].inputs.map(input => 'dataset' in input ? input.dataset.version : null)).toEqual([1, 2]);
    expect(wf.datasetSnapshots?.train?.[0].fsxPath).toBe('/fsx/datasets/projects/p/data/v1');
    expect(wf.datasetSnapshots?.train?.[1].fsxPath).toBe('/fsx/datasets/projects/p/data/v2');
    for (const [index, path] of ['/fsx/datasets/projects/p/data/v1', '/fsx/datasets/projects/p/data/v2'].entries()) {
      const mountPath = aliases ? ['/first', '/second'][index] : path;
      expect(main.volumeMounts).toContainEqual({ name: 'fsx', mountPath, subPath: path.slice(5), readOnly: true });
      expect(main.command?.join(' ')).toContain(`${mountPath}/${index === 0 ? 'a' : 'b'}`);
    }
    expect(main.env?.find(env => env.name === 'PAI_RUNTIME_TOKEN')).toMatchObject({ valueFrom: { secretKeyRef: { key: 'PAI_RUNTIME_TOKEN' } } });
    expect(pod.initContainers.map(container => container.name)).toEqual(expect.arrayContaining(['pai-input-hydration', 'pai-isolation-ready']));
    expect(pod.initContainers.find(container => container.name === 'pai-input-hydration')?.command).toContain('--prepare-inputs');
  });
  it('does not silently accept ambiguous name-only resolution for two versions', () => {
    const { spec } = parseWorkflowYaml(yaml + '      inputs: [{dataset: {name: data, version: 1}}, {dataset: {name: data, version: 2}}]\n');
    expect(() => compileTask(spec, spec.workflow.tasks[0], {
      workflowId: 'run', projectId: 'p', owner: 'alice', namespace: 'team',
      runtimeImage: 'trusted/runtime:fixed', credentialValues: {}, datasetPaths: { data: '/fsx/datasets/projects/p/data/v2' },
    })).toThrow(/indexed|index/i);
  });
  it('rejects two pinned versions that reuse the same mount alias', () => {
    const { spec } = parseWorkflowYaml(yaml + '      inputs: [{dataset: {name: data, version: 1, path: /shared}}, {dataset: {name: data, version: 2, path: /shared}}]\n');
    expect(() => compileTask(spec, spec.workflow.tasks[0], {
      workflowId: 'run', projectId: 'p', owner: 'alice', namespace: 'team',
      runtimeImage: 'trusted/runtime:fixed', credentialValues: {}, datasetPaths: {},
      datasetPathsByInput: { 0: '/fsx/datasets/projects/p/data/v1', 1: '/fsx/datasets/projects/p/data/v2' },
    })).toThrow(/mount.*conflict|alias/i);
  });
});
