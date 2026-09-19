import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import type { Job, Pod } from '../k8s/resources';
import { cancelWorkflow, controllerStatus, deriveTaskPhase, emfMetrics, reconcileFresh, reconcileWorkflow, submitWorkflow, type ControllerDeps, type K8sPort } from './controller';
class FakeK8s implements K8sPort {
  jobs = new Map<string, Job>();
  pods = new Map<string, Pod[]>();
  queue = new Map<string, 'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown'>();
  created: unknown[] = [];
  deleted: string[] = [];
  configMaps: Record<string, Record<string, string>> = {};
  secrets: Record<string, Record<string, string>> = {};
  async getJob(_ns: string, name: string) {
    return this.jobs.get(name) ?? null;
  }
  async listPods(_ns: string, sel: string) {
    return this.pods.get(sel.replace('job-name=', '')) ?? [];
  }
  async createJob(_ns: string, job: unknown) {
    const j = job as Job;
    this.created.push(job);
    this.jobs.set(j.metadata.name, {
      ...j,
      status: {
        active: 1
      }
    });
  }
  async deleteJob(_ns: string, name: string) {
    this.deleted.push(name);
    this.jobs.delete(name);
  }
  async upsertConfigMap(_ns: string, name: string, data: Record<string, string>) {
    this.configMaps[name] = data;
  }
  async upsertSecret(_ns: string, name: string, data: Record<string, string>) {
    this.secrets[name] = data;
  }
  async deleteByLabel() {}
  async ensureNamespace() {}
  async ensureFsxPvc() {}
  async ensureServiceAccount() {}
  async queueState(_ns: string, job: string) {
    return this.queue.get(job) ?? 'unknown';
  }
  succeed(name: string) {
    const j = this.jobs.get(name)!;
    this.jobs.set(name, {
      ...j,
      status: {
        succeeded: j.spec.completions ?? 1,
        conditions: [{
          type: 'Complete',
          status: 'True'
        }]
      }
    });
  }
  fail(name: string, msg = 'BackoffLimitExceeded') {
    const j = this.jobs.get(name)!;
    this.jobs.set(name, {
      ...j,
      status: {
        failed: 1,
        conditions: [{
          type: 'Failed',
          status: 'True',
          reason: msg,
          message: 'Job has reached the specified backoff limit'
        }]
      }
    });
  }
  run(name: string) {
    this.pods.set(name, [{
      metadata: {
        name: `${name}-x`
      },
      spec: {
        containers: []
      },
      status: {
        phase: 'Running',
        startTime: '2026-01-01T00:00:01Z'
      }
    }]);
  }
}
const YAML_TEXT = `
workflow:
  name: pipe
  namespace: rl
  timeout: { exec_timeout: 1h, queue_timeout: 10m }
  resources:
    cpu: { cpu: 1, memory: 1Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: a
      resource: cpu
      image: python:3.11
      command: [echo, a]
    - name: b
      resource: cpu
      image: python:3.11
      command: [echo, b]
      inputs: [{ task: a }]
      outputs: [{ dataset: { name: out-b, path: "{{output}}" } }]
    - name: c
      resource: cpu
      image: python:3.11
      command: [echo, c]
      inputs: [{ task: a }]
`;
let repo: Repo;
let k8s: FakeK8s;
let clock: Date;
let notifications: string[];
let deps: ControllerDeps;
beforeEach(() => {
  repo = new Repo(new MemoryKV());
  k8s = new FakeK8s();
  clock = new Date('2026-01-01T00:00:00Z');
  notifications = [];
  deps = {
    repo,
    k8s,
    now: () => clock,
    notify: async s => {
      notifications.push(s);
    },
    resolveCredential: async r => `resolved:${r}`,
    dataBucket: 'bkt',
    artifactPublisher: {
      publish: async ({
        sourcePath
      }) => ({
        state: 'ready',
        uri: `s3://bkt/${sourcePath.replace(/^\/fsx\//, '')}`,
        manifestUri: 's3://bkt/manifests/result.json',
        manifestHash: 'a'.repeat(64),
        verifiedAt: clock.toISOString(),
        objectCount: 1,
        sizeBytes: 10
      })
    }
  };
});
describe('submit + reconcile', () => {
  it('launches roots on submit, dependents after success, publishes outputs, finishes SUCCEEDED', async () => {
    const wf = await submitWorkflow({
      yaml: YAML_TEXT,
      owner: 'alice'
    }, deps);
    expect(wf.status).toBe('RUNNING');
    let tasks = await repo.listTasks(wf.id);
    expect(tasks.find(t => t.name === 'a')?.phase).toBe('PENDING');
    expect(tasks.find(t => t.name === 'b')?.phase).toBe('WAITING');
    expect(k8s.created).toHaveLength(1);
    k8s.run('wf-' + wf.id + '-a');
    await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect((await repo.listTasks(wf.id)).find(t => t.name === 'a')?.phase).toBe('RUNNING');
    k8s.succeed('wf-' + wf.id + '-a');
    await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    tasks = await repo.listTasks(wf.id);
    expect(tasks.find(t => t.name === 'a')?.phase).toBe('SUCCEEDED');
    expect(tasks.find(t => t.name === 'b')?.phase).toBe('PENDING');
    expect(tasks.find(t => t.name === 'c')?.phase).toBe('PENDING');
    expect(k8s.created).toHaveLength(3);
    k8s.succeed('wf-' + wf.id + '-b');
    k8s.succeed('wf-' + wf.id + '-c');
    const done = await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.succeededCount).toBe(3);
    const ds = await repo.getDataset('out-b');
    expect(ds?.latestVersion).toBe(1);
    const v = await repo.getVersion('out-b', 1);
    expect(v?.uri).toBe(`s3://bkt/checkpoints/workflows/${wf.id}/b`);
    expect(v?.producedBy).toEqual({
      workflowId: wf.id,
      task: 'b'
    });
    expect(notifications).toEqual([`[Physical AI] workflow pipe SUCCEEDED`]);
    const events = await repo.listEvents(wf.id);
    expect(events.map(e => e.reason)).toEqual(expect.arrayContaining(['Submitted', 'TaskLaunched', 'TaskSucceeded', 'DatasetPublished', 'WorkflowSucceeded']));
  });
  it('cancel_pending: failure cancels running siblings and skips waiting tasks', async () => {
    const wf = await submitWorkflow({
      yaml: YAML_TEXT,
      owner: 'alice'
    }, deps);
    k8s.fail('wf-' + wf.id + '-a');
    const out = await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect(out.status).toBe('FAILED');
    expect(out.message).toMatch(/task a: BackoffLimitExceeded/);
    const tasks = await repo.listTasks(wf.id);
    expect(tasks.find(t => t.name === 'b')?.phase).toBe('SKIPPED');
    expect(tasks.find(t => t.name === 'c')?.phase).toBe('SKIPPED');
  });
  it('continue policy lets independent branches finish', async () => {
    const y = YAML_TEXT.replace('timeout: { exec_timeout: 1h, queue_timeout: 10m }', 'timeout: { exec_timeout: 1h, queue_timeout: 10m }\n  on_failure: continue');
    const wf = await submitWorkflow({
      yaml: y,
      owner: 'alice'
    }, deps);
    k8s.succeed('wf-' + wf.id + '-a');
    await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    k8s.fail('wf-' + wf.id + '-b');
    let out = await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect(out.status).toBe('RUNNING'); // c still running
    k8s.succeed('wf-' + wf.id + '-c');
    out = await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect(out.status).toBe('FAILED');
    expect(out.succeededCount).toBe(2);
  });
  it('queue timeout fails a task stuck waiting for Kueue admission', async () => {
    const y = YAML_TEXT.replace('namespace: rl', 'namespace: hyperpod-ns-team-a');
    const wf = await submitWorkflow({
      yaml: y,
      owner: 'alice'
    }, deps);
    const jobA = 'wf-' + wf.id + '-a';
    expect((k8s.created[0] as Job).metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('hyperpod-ns-team-a-localqueue');
    k8s.queue.set(jobA, 'pending');
    await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect((await repo.listTasks(wf.id)).find(t => t.name === 'a')?.phase).toBe('QUEUED');
    clock = new Date(clock.getTime() + 11 * 60_000);
    const out = await reconcileWorkflow((await repo.getWorkflow(wf.id))!, deps);
    expect(out.status).toBe('FAILED');
    expect(k8s.deleted).toContain(jobA);
  });
  it('cancel deletes jobs and marks CANCELLED', async () => {
    const wf = await submitWorkflow({
      yaml: YAML_TEXT,
      owner: 'alice'
    }, deps);
    const c = await cancelWorkflow(wf.id, 'bob', deps);
    expect(c.status).toBe('CANCELLED');
    expect(k8s.deleted).toEqual(['wf-' + wf.id + '-a']);
    expect((await repo.listTasks(wf.id)).every(t => t.phase === 'CANCELLED')).toBe(true);
  });
  it('rejects dataset inputs that do not exist at submit time', async () => {
    const y = YAML_TEXT.replace('command: [echo, a]', 'command: [echo, a]\n      inputs: [{ dataset: { name: nope, path: /d } }]');
    await expect(submitWorkflow({
      yaml: y,
      owner: 'alice'
    }, deps)).rejects.toThrow(/dataset nope does not exist/);
  });
  it('rejects credential refs outside the allow-listed SSM prefixes', async () => {
    const y = YAML_TEXT.replace('command: [echo, a]', 'command: [echo, a]\n      credentials: { hf: { HF_TOKEN: literal-token } }');
    await expect(submitWorkflow({
      yaml: y,
      owner: 'alice'
    }, deps)).rejects.toThrow(/must be an SSM parameter path/);
  });
  it('resolves credentials into a Secret', async () => {
    const y = YAML_TEXT.replace('command: [echo, a]', 'command: [echo, a]\n      credentials: { hf: { HF_TOKEN: /groot/hf-token } }');
    const wf = await submitWorkflow({
      yaml: y,
      owner: 'alice'
    }, deps);
    expect(k8s.secrets[`wf-${wf.id}-a-creds`]).toEqual({
      HF_TOKEN: 'resolved:/groot/hf-token'
    });
  });
});
describe('deriveTaskPhase', () => {
  const job = (extra: Partial<Job['status']> = {}, spec: Partial<Job['spec']> = {}): Job => ({
    metadata: {
      name: 'j'
    },
    spec: {
      template: {
        spec: {
          containers: []
        }
      },
      ...spec
    },
    status: extra
  });
  it('maps states', () => {
    expect(deriveTaskPhase(null, [], 'unknown', 1).phase).toBe('FAILED');
    expect(deriveTaskPhase(job({
      succeeded: 1
    }), [], 'unknown', 1).phase).toBe('SUCCEEDED');
    expect(deriveTaskPhase(job({
      succeeded: 1
    }, {
      completions: 2
    }), [], 'unknown', 2).phase).not.toBe('SUCCEEDED');
    expect(deriveTaskPhase(job({
      active: 1
    }), [], 'pending', 1).phase).toBe('QUEUED');
    expect(deriveTaskPhase(job({
      active: 1
    }, {
      suspend: true
    }), [], 'unknown', 1).phase).toBe('QUEUED');
    const pendingPod: Pod = {
      metadata: {
        name: 'p'
      },
      spec: {
        containers: []
      },
      status: {
        phase: 'Pending',
        conditions: [{
          type: 'PodScheduled',
          status: 'False',
          message: '0/2 nodes are available: Insufficient nvidia.com/gpu'
        }]
      }
    };
    const d = deriveTaskPhase(job({
      active: 1
    }), [pendingPod], 'unknown', 1);
    expect(d.phase).toBe('PENDING');
    expect(d.message).toMatch(/Insufficient nvidia.com\/gpu/);
  });
  it('keeps a task RUNNING while a finished pod waits for the Job Complete condition', () => {
    // Between the pod finishing and the Job controller writing Complete, the pod is Succeeded but the Job
    // has neither a condition nor .status.succeeded. Reporting PENDING here regresses the task to
    // INITIALIZING and lets start_timeout fail a long run at the moment it completes.
    const finishedPod: Pod = {
      metadata: { name: 'p' },
      spec: { containers: [] },
      status: { phase: 'Succeeded', startTime: '2026-09-19T16:29:29Z', containerStatuses: [{ name: 'main', ready: false, restartCount: 0, state: { terminated: { exitCode: 0 } } }] },
    };
    const d = deriveTaskPhase(job({ active: 0 }), [finishedPod], 'admitted', 1);
    expect(d.phase).toBe('RUNNING');
    expect(d.startedAt).toBe('2026-09-19T16:29:29Z');
    expect(d.message).toMatch(/Job completion/);
  });
});

describe('controller liveness', () => {
  afterEach(() => {
    const status = controllerStatus();
    status.running = false;
    status.lastTick = undefined;
    status.inFlightSince = undefined;
  });

  it('is healthy only while reconcile ticks are fresh', () => {
    const status = controllerStatus();
    const now = Date.parse('2026-09-18T12:00:00Z');
    status.running = true;
    status.lastTick = new Date(now - 10_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(true);
    status.lastTick = new Date(now - 31_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
    status.lastTick = undefined;
    expect(reconcileFresh(now, 30_000, 20)).toBe(true);
    expect(reconcileFresh(now, 30_000, 61)).toBe(false);
    status.running = false;
    status.lastTick = new Date(now - 1000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
  });

  it('stays healthy while a long reconcile pass is in flight, until the in-flight bound', () => {
    const status = controllerStatus();
    const now = Date.parse('2026-09-18T12:00:00Z');
    status.running = true;
    status.lastTick = new Date(now - 120_000).toISOString();
    status.inFlightSince = new Date(now - 300_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(true);
    status.inFlightSince = new Date(now - 601_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
    status.inFlightSince = undefined;
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
  });

  it('formats one embedded-metric-format line per tick', () => {
    const line = JSON.parse(emfMetrics({ ReconcileLagSeconds: 5.5, ActiveWorkflows: 3 }, 1_700_000_000_000));
    expect(line.Service).toBe('controller');
    expect(line.ReconcileLagSeconds).toBe(5.5);
    expect(line.ActiveWorkflows).toBe(3);
    expect(line._aws.Timestamp).toBe(1_700_000_000_000);
    expect(line._aws.CloudWatchMetrics).toEqual([{
      Namespace: 'PhysicalAI/Dashboard',
      Dimensions: [['Service']],
      Metrics: [{ Name: 'ReconcileLagSeconds', Unit: 'Seconds' }, { Name: 'ActiveWorkflows', Unit: 'Count' }],
    }]);
  });
});
