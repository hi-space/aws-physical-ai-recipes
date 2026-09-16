import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import type { Job, Pod } from '../k8s/resources';
import { cancelWorkflow, reconcileAll, reconcileWorkflow, submitWorkflow, retryWorkflow, type ControllerDeps, type K8sPort } from './controller';
class Cluster implements K8sPort {
  jobs = new Map<string, Job>();
  pods: Pod[] = [];
  creates = 0;
  failDelete = false;
  retainDeleted = false;
  loseCreateReply = false;
  async ensureNamespace() {}
  async ensureFsxPvc() {}
  async getJob(_ns: string, name: string) {
    return this.jobs.get(name) ?? null;
  }
  async listPods(_ns: string, selector: string) {
    return this.pods.filter(p => selector.split(',').every(pair => {
      const [k, v] = pair.split('=');
      return p.metadata.labels?.[k] === v;
    }));
  }
  async createJob(_ns: string, body: unknown) {
    const job = body as Job;
    if (this.jobs.has(job.metadata.name)) throw Object.assign(new Error('already exists'), {
      status: 409
    });
    this.creates++;
    this.jobs.set(job.metadata.name, structuredClone(job));
    if (this.loseCreateReply) throw new Error('connection lost after create');
  }
  async deleteJob(_ns: string, name: string) {
    if (this.failDelete) throw new Error('delete unavailable');
    if (!this.retainDeleted) this.jobs.delete(name);
  }
  async upsertConfigMap() {}
  async upsertSecret() {}
  async deleteByLabel() {}
  async queueState() {
    return 'unknown' as const;
  }
  succeed(name: string) {
    this.jobs.get(name)!.status = {
      conditions: [{
        type: 'Complete',
        status: 'True'
      }]
    };
  }
  fail(name: string) {
    this.jobs.get(name)!.status = {
      conditions: [{
        type: 'Failed',
        status: 'True',
        reason: 'UserExit'
      }]
    };
  }
}
const yaml = `workflow:
  name: reliable
  namespace: rl
  on_failure: continue
  resources: { cpu: { cpu: 1 } }
  tasks:
    - name: first
      resource: cpu
      image: busybox
      command: [echo, ok]
`;
let repo: Repo, k8s: Cluster, deps: ControllerDeps;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  repo = new Repo(new MemoryKV());
  k8s = new Cluster();
  deps = {
    repo,
    k8s,
    now: () => new Date(),
    notify: async () => {},
    resolveCredential: async () => ''
  };
});
afterEach(() => vi.useRealTimers());
describe('durable execution', () => {
  it('binds immutable attempt Secret UIDs into every JobSet child before creating the group', async () => {
    let group: import('./ports').JobSet | null = null;
    const captured: import('./ports').JobSet[] = [];
    deps.runtimeCommand = '/runtime';
    deps.runtimeEnvironment = () => ({ PAI_RUNTIME_TOKEN: 'original-runtime-capability' });
    deps.groupRuntime = { observe: async () => ({ epoch: '', barrierReleased: false, tasks: {} }), fence: async () => {} };
    deps.k8s.getJobSet = async () => group;
    deps.k8s.createJobSet = async (_namespace, value) => { const saved = structuredClone(value) as import('./ports').JobSet; group = saved; captured.push(saved); };
    deps.k8s.deleteJobSet = async () => { group = null; };
    const secrets = vi.fn(async (_namespace: string, name: string) => ({ uid: `uid-${name}` }));
    deps.k8s.ensureAttemptSecret = secrets;
    const source = `workflow:
  name: grouped-secret
  namespace: rl
  resources: {cpu: {cpu: 1}}
  groups:
    - name: pair
      tasks:
        - {name: lead, lead: true, resource: cpu, image: busybox, command: [echo, lead]}
        - {name: peer, resource: cpu, image: busybox, command: [echo, peer]}
`;
    const workflow = await submitWorkflow({ yaml: source, owner: 'alice' }, deps);
    expect(captured).toHaveLength(1);
    expect(secrets).toHaveBeenCalledTimes(2);
    for (const child of captured[0].spec.replicatedJobs) {
      const name = `wf-${workflow.id}-${child.name}-creds`;
      expect(child.template.spec.template.metadata?.annotations).toMatchObject({
        'pai.aws/attempt-secret-name': name, 'pai.aws/attempt-secret-uid': `uid-${name}`,
      });
    }
  });
  it('deduplicates simultaneous submissions and rejects changed spec with same scoped key', async () => {
    const input = {
      yaml,
      owner: 'alice',
      idempotencyKey: 'once'
    };
    const [a, b] = await Promise.all([submitWorkflow(input, deps), submitWorkflow(input, deps)]);
    expect(a.id).toBe(b.id);
    expect(k8s.creates).toBe(1);
    expect(await repo.listTasks(a.id)).toHaveLength(1);
    await expect(submitWorkflow({
      ...input,
      yaml: yaml.replace('echo, ok', 'echo, changed')
    }, deps)).rejects.toMatchObject({
      status: 409
    });
  });
  it('persists launch intent and adopts job after lost create reply', async () => {
    k8s.loseCreateReply = true;
    const w = await submitWorkflow({
      yaml,
      owner: 'alice'
    }, deps);
    expect((await repo.listTasks(w.id))[0].jobName).toBeDefined();
    expect((await repo.listTasks(w.id))[0].phase).not.toBe('FAILED');
    k8s.loseCreateReply = false;
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
    expect((await repo.listTasks(w.id))[0].attempts).toBe(1);
  });
  it('keeps cancel pending through delete errors, asynchronous deletes and surviving pods', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'alice'
    }, deps);
    const name = (await repo.listTasks(w.id))[0].jobName!;
    k8s.failDelete = true;
    expect((await cancelWorkflow(w.id, 'alice', deps)).status).toBe('CANCELLING');
    expect((await repo.listTasks(w.id))[0].phase).toBe('CANCELLING');
    k8s.failDelete = false;
    k8s.retainDeleted = true;
    expect((await reconcileWorkflow(w, deps)).status).toBe('CANCELLING');
    k8s.retainDeleted = false;
    k8s.pods = [{
      metadata: {
        name: 'terminating',
        labels: {
          'job-name': name
        }
      },
      spec: {
        containers: []
      }
    }];
    expect((await reconcileWorkflow(w, deps)).status).toBe('CANCELLING');
    k8s.pods = [];
    expect((await reconcileWorkflow(w, deps)).status).toBe('CANCELLED');
  });
  it('reconciles old active run beyond 200 newer terminal runs', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'alice'
    }, deps);
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    for (let i = 0; i < 205; i++) await repo.putWorkflow({
      ...w,
      id: `done-${i}`,
      status: 'SUCCEEDED',
      createdAt: '2026-02-01'
    });
    await reconcileAll(deps);
    expect((await repo.getWorkflow(w.id))?.status).toBe('SUCCEEDED');
  });
  it('serializes reconcile calls and ignores stale workflow input', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'alice'
    }, deps);
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    await Promise.all([reconcileWorkflow(w, deps), reconcileWorkflow(w, deps)]);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
    expect((await repo.getWorkflow(w.id))?.status).toBe('SUCCEEDED');
    expect((await repo.listEvents(w.id)).filter(e => e.reason === 'WorkflowSucceeded')).toHaveLength(1);
  });
  it('enforces bounded exponential retry backoff', async () => {
    const w = await submitWorkflow({
      yaml: yaml + '      retry: { max_retries: 2, backoff_seconds: 10 }\n',
      owner: 'alice'
    }, deps);
    k8s.fail((await repo.listTasks(w.id))[0].jobName!);
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id))[0].phase).toBe('RETRY_WAIT');
    await vi.advanceTimersByTimeAsync(9_000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(2);
    k8s.fail((await repo.listTasks(w.id))[0].jobName!);
    await reconcileWorkflow(w, deps);
    await vi.advanceTimersByTimeAsync(19_000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(3);
    k8s.fail((await repo.listTasks(w.id))[0].jobName!);
    expect((await reconcileWorkflow(w, deps)).status).toBe('FAILED');
  });
  it('keeps outputs FINALIZING without verified publication and publishes once after verification', async () => {
    const w = await submitWorkflow({
      yaml: yaml + '      outputs: [{ dataset: { name: result, path: "{{output}}" } }]\n',
      owner: 'alice'
    }, deps);
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    expect((await reconcileWorkflow(w, deps)).status).toBe('FINALIZING');
    expect(await repo.getDataset('result')).toBeUndefined();
    deps.artifactPublisher = {
      publish: async () => ({
        state: 'ready',
        uri: 's3://durable/result/',
        manifestUri: 's3://durable/result/manifest.json',
        manifestHash: 'a'.repeat(64),
        verifiedAt: new Date().toISOString(),
        objectCount: 1,
        sizeBytes: 10
      })
    };
    expect((await reconcileWorkflow(w, deps)).status).toBe('SUCCEEDED');
    await reconcileWorkflow(w, deps);
    expect((await repo.getDataset('result'))?.latestVersion).toBe(1);
    expect((await repo.getVersion('result', 1))?.uri).toBe('s3://durable/result/');
  });
  it('pins dataset version and path before deferred execution', async () => {
    await repo.putDataset({
      name: 'input',
      owner: 'alice',
      latestVersion: 1,
      tags: [],
      createdAt: 'x',
      updatedAt: 'x'
    });
    await repo.putVersion({
      dataset: 'input',
      version: 1,
      uri: 's3://b/datasets/input/v1/',
      fsxPath: '/fsx/datasets/input/v1',
      createdAt: 'x',
      createdBy: 'alice',
      tags: []
    });
    const w = await submitWorkflow({
      yaml: yaml + '      inputs: [{ dataset: { name: input } }]\n',
      owner: 'alice',
      deferLaunch: true
    }, deps);
    expect(k8s.creates).toBe(0);
    await repo.putDataset({
      ...(await repo.getDataset('input'))!,
      latestVersion: 2
    });
    await repo.putVersion({
      ...(await repo.getVersion('input', 1))!,
      version: 2,
      fsxPath: '/fsx/datasets/input/v2'
    });
    await reconcileWorkflow(w, deps);
    expect(w.spec.workflow.tasks[0].inputs[0]).toMatchObject({
      dataset: {
        version: 1
      }
    });
    expect(w.datasetSnapshots?.first?.[0].fsxPath).toBe('/fsx/datasets/input/v1');
  });
  it('defers Kubernetes mutations and persists trusted project namespace, queue, subject', async () => {
    deps.k8s.ensureNamespace = async () => {
      throw new Error('must not mutate');
    };
    const w = await submitWorkflow({
      yaml,
      owner: 'alice',
      ownerSubject: 'sub-a',
      projectId: 'robotics',
      namespace: 'team-a',
      queue: 'approved',
      deferLaunch: true
    }, deps);
    expect(w).toMatchObject({
      namespace: 'team-a',
      projectId: 'robotics',
      ownerSubject: 'sub-a'
    });
    expect(w.spec.workflow.queue).toBe('approved');
    expect(k8s.creates).toBe(0);
    await expect(submitWorkflow({
      yaml,
      owner: 'a',
      projectId: 'robotics',
      namespace: 'team-a',
      queue: 'none',
      deferLaunch: true
    }, deps)).rejects.toThrow(/queue/);
  });
});
describe('recovery under concurrency and external failures', () => {
  it('renews a lease while slow IO is pending and excludes a second reconciler', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'a',
      deferLaunch: true
    }, deps);
    let release!: () => void;
    const wait = new Promise<void>(r => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>(r => {
      entered = r;
    });
    const create = k8s.createJob.bind(k8s);
    k8s.createJob = async (ns, body) => {
      entered();
      await wait;
      await create(ns, body);
    };
    const run = reconcileWorkflow(w, deps);
    await started;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await repo.acquireRunLease(w.id, 30)).toBeUndefined();
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(0);
    release();
    await run;
    expect(k8s.creates).toBe(1);
  });
  it('retains a launch intent when ledger update fails after create and adopts it after restart', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'a',
      deferLaunch: true
    }, deps);
    const put = repo.putTasks.bind(repo);
    let failed = false;
    repo.putTasks = async (tasks, lease) => {
      if (!failed && k8s.creates === 1 && tasks.some(t => t.phase === 'PENDING')) {
        failed = true;
        throw new Error('ledger interrupted');
      }
      return put(tasks, lease);
    };
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id))[0].phase).toBe('LAUNCHING');
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
    expect((await repo.listTasks(w.id))[0].attempts).toBe(1);
  });
  it('does not adopt an unrelated workload that happens to have the deterministic name', async () => {
    const w = await submitWorkflow({
      yaml,
      owner: 'a',
      deferLaunch: true
    }, deps);
    k8s.jobs.set(`wf-${w.id}-first`, {
      metadata: {
        name: `wf-${w.id}-first`,
        labels: {
          'pai.aws/workflow-id': 'someone-else'
        }
      },
      spec: {
        template: {
          spec: {
            containers: []
          }
        }
      }
    });
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(0);
    expect((await repo.listTasks(w.id))[0].message).toMatch(/ownership/);
  });
  it('does not mark an active old attempt RETRY_WAIT before its pods terminate', async () => {
    const w = await submitWorkflow({
      yaml: yaml + '      retry: { max_retries: 1, backoff_seconds: 1 }\n',
      owner: 'a'
    }, deps);
    const t = (await repo.listTasks(w.id))[0];
    k8s.fail(t.jobName!);
    k8s.pods = [{
      metadata: {
        name: 'lingering',
        labels: {
          'job-name': t.jobName!
        }
      },
      spec: {
        containers: []
      }
    }];
    await reconcileWorkflow(w, deps);
    await vi.advanceTimersByTimeAsync(5000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
    expect((await repo.listTasks(w.id))[0].phase).toBe('CANCELLING');
    k8s.pods = [];
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(2);
  });
  it('retains FINALIZING after publisher failures and rejects a ready receipt without a verified manifest', async () => {
    const w = await submitWorkflow({
      yaml: yaml + '      outputs: [{ dataset: { name: result, path: "{{output}}" } }]\n',
      owner: 'a'
    }, deps);
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    deps.artifactPublisher = {
      publish: async () => {
        throw new Error('export still running');
      }
    };
    expect((await reconcileWorkflow(w, deps)).status).toBe('FINALIZING');
    deps.artifactPublisher = {
      publish: async () => ({
        state: 'ready',
        uri: 'fsx:///only-local',
        manifestUri: '',
        manifestHash: '',
        verifiedAt: '',
        objectCount: 0,
        sizeBytes: 0
      })
    };
    expect((await reconcileWorkflow(w, deps)).status).toBe('FINALIZING');
    expect(await repo.getDataset('result')).toBeUndefined();
  });
  it('retries outbox start and terminal callbacks without launching duplicate jobs', async () => {
    let attempts = 0;
    const keys: string[] = [];
    deps.dispatchWorkflow = async (_w, c) => {
      keys.push(c.idempotencyKey);
      if (++attempts === 1) throw new Error('lost reply');
      return {
        executionArn: 'arn:execution:one'
      };
    };
    const w = await submitWorkflow({
      yaml,
      owner: 'a',
      idempotencyKey: 'dispatch',
      deferLaunch: true
    }, deps);
    expect(k8s.creates).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await reconcileWorkflow(w, deps);
    expect(attempts).toBe(2);
    expect(new Set(keys).size).toBe(1);
    let callbacks = 0;
    deps.completeWorkflow = async () => {
      if (++callbacks === 1) throw new Error('callback unavailable');
    };
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    expect((await reconcileWorkflow(w, deps)).status).toBe('SUCCEEDED');
    await vi.advanceTimersByTimeAsync(1000);
    await reconcileAll(deps);
    expect(callbacks).toBe(2);
    expect(k8s.creates).toBe(1);
  });
  it('uses each branch execution start for deadline and keeps an independent sibling running', async () => {
    const y = yaml.replace('  on_failure: continue', '  on_failure: continue\n  timeout: { exec_timeout: 5s, start_timeout: 1m, queue_timeout: 1m }') + `    - name: second
      resource: cpu
      image: busybox
      command: [echo, ok]
`;
    const w = await submitWorkflow({
      yaml: y,
      owner: 'a'
    }, deps);
    const [a, b] = await repo.listTasks(w.id);
    k8s.pods = [{
      metadata: {
        name: 'a',
        labels: {
          'job-name': a.jobName!
        }
      },
      spec: {
        containers: []
      },
      status: {
        phase: 'Running',
        startTime: new Date().toISOString()
      }
    }];
    await reconcileWorkflow(w, deps);
    await vi.advanceTimersByTimeAsync(6000);
    k8s.pods.push({
      metadata: {
        name: 'b',
        labels: {
          'job-name': b.jobName!
        }
      },
      spec: {
        containers: []
      },
      status: {
        phase: 'Running',
        startTime: new Date().toISOString()
      }
    });
    await reconcileWorkflow(w, deps);
    k8s.pods = k8s.pods.filter(p => p.metadata.name !== 'a');
    await reconcileWorkflow(w, deps);
    const tasks = await repo.listTasks(w.id);
    expect(tasks.find(t => t.name === a.name)?.phase).toBe('FAILED');
    expect(tasks.find(t => t.name === b.name)?.phase).toBe('RUNNING');
  });
});
describe('native group lifecycle', () => {
  const grouped = (ignore = false) => `workflow:
  name: group
  namespace: rl
  on_failure: continue
  resources: { cpu: { cpu: 1 } }
  groups:
    - name: pair
      ignoreNonleadStatus: ${ignore}
      retry: { max_retries: 1, backoff_seconds: 10 }
      timeout: { exec: 1h, queue: 1m, start: 5s }
      tasks:
        - { name: leader, lead: true, resource: cpu, image: python, command: [echo, leader] }
        - { name: worker, resource: cpu, image: python, command: [echo, worker] }
`;
  function wire() {
    const roots = new Map<string, import('./ports').JobSet>();
    let creates = 0;
    let failedDelete = false;
    const runtime: {
      released: boolean;
      leader: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
      worker: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    } = {
      released: false,
      leader: 'RUNNING',
      worker: 'RUNNING'
    };
    const fenced: string[] = [];
    deps.k8s.getJobSet = async (_ns, name) => roots.get(name) ?? null;
    deps.k8s.createJobSet = async (_ns, body) => {
      const root = body as import('./ports').JobSet;
      creates++;
      roots.set(root.metadata.name, root);
    };
    deps.k8s.deleteJobSet = async (_ns, name) => {
      if (failedDelete) throw new Error('delete unavailable');
      roots.delete(name);
    };
    deps.runtimeCommand = '/trusted/pai-runtime';
    deps.groupRuntime = {
      observe: async (_wf, _group, epoch) => ({
        epoch,
        barrierReleased: runtime.released,
        tasks: {
          leader: {
            phase: runtime.leader
          },
          worker: {
            phase: runtime.worker
          }
        }
      }),
      fence: async (_wf, _group, epoch) => {
        fenced.push(epoch);
      }
    };
    return {
      roots,
      runtime,
      fenced,
      get creates() {
        return creates;
      },
      set failDelete(v: boolean) {
        failedDelete = v;
      }
    };
  }
  it('rejects groups before launch when JobSet/barrier runtime is absent', async () => {
    await expect(submitWorkflow({
      yaml: grouped(),
      owner: 'a'
    }, deps)).rejects.toThrow(/JobSet.*runtime/);
    expect(k8s.creates).toBe(0);
  });
  it('retries whole group after fencing and deleting a single admission root, with backoff', async () => {
    const g = wire();
    const w = await submitWorkflow({
      yaml: grouped(),
      owner: 'a'
    }, deps);
    expect(g.creates).toBe(1);
    expect(k8s.creates).toBe(0);
    let tasks = await repo.listTasks(w.id);
    expect(new Set(tasks.map(t => t.jobName)).size).toBe(1);
    g.runtime.released = true;
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'RUNNING')).toBe(true);
    g.runtime.worker = 'FAILED';
    g.failDelete = true;
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'CANCELLING')).toBe(true);
    const oldEpoch = tasks[0].attemptEpoch;
    expect(g.fenced).toContain(oldEpoch);
    expect(g.creates).toBe(1);
    g.failDelete = false;
    await reconcileWorkflow(w, deps);
    expect(g.roots.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    g.runtime.worker = 'RUNNING';
    await reconcileWorkflow(w, deps);
    tasks = await repo.listTasks(w.id);
    expect(g.creates).toBe(2);
    expect(tasks.every(t => t.attempts === 2)).toBe(true);
    expect(tasks[0].attemptEpoch).not.toBe(oldEpoch);
  });
  it('holds group initializing until barrier and times out the start phase', async () => {
    const g = wire();
    const w = await submitWorkflow({
      yaml: grouped().replace('max_retries: 1', 'max_retries: 0'),
      owner: 'a'
    }, deps);
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'INITIALIZING')).toBe(true);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await reconcileWorkflow(w, deps)).status).toBe('FAILED');
    expect(g.roots.size).toBe(0);
  });
  it('honors ignoreNonleadStatus and waits for leader plus confirmed group termination', async () => {
    const g = wire();
    const w = await submitWorkflow({
      yaml: grouped(true),
      owner: 'a'
    }, deps);
    g.runtime.released = true;
    g.runtime.worker = 'FAILED';
    expect((await reconcileWorkflow(w, deps)).status).toBe('RUNNING');
    g.runtime.leader = 'SUCCEEDED';
    g.failDelete = true;
    expect((await reconcileWorkflow(w, deps)).status).toBe('RUNNING');
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'CANCELLING')).toBe(true);
    g.failDelete = false;
    expect((await reconcileWorkflow(w, deps)).status).toBe('SUCCEEDED');
    expect(g.roots.size).toBe(0);
    expect((await repo.listTasks(w.id)).find(t => t.name === 'worker')).toMatchObject({
      observedPhase: 'FAILED',
      ignoredByGroupPolicy: true
    });
  });
  it('lets sibling groups keep their execution budgets when another group hits a deadline', async () => {
    const g = wire();
    const y = grouped().replace('  on_failure: continue\n', '').replace('max_retries: 1', 'max_retries: 0') + `    - name: sibling
      tasks:
        - { name: other, lead: true, resource: cpu, image: python, command: [echo, other] }
`;
    deps.groupRuntime!.observe = async (_wf, group, epoch) => {
      const tasks: import('./ports').GroupRuntimeState['tasks'] = {};
      if (group === 'sibling') tasks.other = {
        phase: 'RUNNING'
      };else {
        tasks.leader = {
          phase: 'INITIALIZING'
        };
        tasks.worker = {
          phase: 'INITIALIZING'
        };
      }
      return {
        epoch,
        barrierReleased: group === 'sibling',
        tasks
      };
    };
    const w = await submitWorkflow({
      yaml: y,
      owner: 'a'
    }, deps);
    await reconcileWorkflow(w, deps);
    await vi.advanceTimersByTimeAsync(5001);
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id)).find(t => t.name === 'other')?.phase).toBe('RUNNING');
    expect(g.roots.size).toBe(1);
  });
  it('handles terminal JobSet failure even if runtime state is stale', async () => {
    const g = wire();
    const w = await submitWorkflow({
      yaml: grouped(),
      owner: 'a'
    }, deps);
    g.roots.values().next().value!.status = {
      conditions: [{
        type: 'Failed',
        status: 'True',
        reason: 'FailedJobs'
      }]
    };
    await reconcileWorkflow(w, deps);
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'RETRY_WAIT')).toBe(true);
  });
  it('calls the runtime environment hook with the durable epoch before creating a group', async () => {
    const g = wire();
    deps.runtimeCommand = undefined;
    deps.runtimeImage = 'trusted/runtime:fixed';
    const calls: {
      task: string;
      epoch: string;
      attempt: number;
    }[] = [];
    deps.runtimeEnvironment = (_wf, task, epoch, attempt) => {
      calls.push({
        task: task.name,
        epoch,
        attempt
      });
      return {
        PAI_RUNTIME_TOKEN: `signed-${epoch}-${task.name}`
      };
    };
    const create = deps.k8s.createJobSet!;
    deps.k8s.createJobSet = async (ns, body) => {
      const root = body as import('./ports').JobSet;
      const wfId = root.metadata.labels!['pai.aws/workflow-id'];
      const durable = await repo.listTasks(wfId);
      expect(durable.every(t => t.phase === 'LAUNCHING')).toBe(true);
      expect(calls.every(c => c.epoch === durable[0].attemptEpoch && c.attempt === 1)).toBe(true);
      expect(calls.map(c => c.task).sort()).toEqual(['leader', 'worker']);
      return create(ns, body);
    };
    const w = await submitWorkflow({
      yaml: grouped(),
      owner: 'a'
    }, deps);
    expect(g.creates).toBe(1);
    expect((await repo.listTasks(w.id)).every(t => t.phase === 'PENDING')).toBe(true);
  });
  it('requires group cancellation fence and external delete confirmation before terminal', async () => {
    const g = wire();
    const w = await submitWorkflow({
      yaml: grouped(),
      owner: 'a'
    }, deps);
    g.failDelete = true;
    expect((await cancelWorkflow(w.id, 'a', deps)).status).toBe('CANCELLING');
    expect(g.fenced.length).toBeGreaterThan(0);
    g.failDelete = false;
    expect((await reconcileWorkflow(w, deps)).status).toBe('CANCELLED');
    expect(g.roots.size).toBe(0);
  });
});
it('does not start workloads while external orchestration dispatch is still unconfirmed', async () => {
  deps.dispatchWorkflow = async () => {
    throw new Error('SFN start unavailable');
  };
  const w = await submitWorkflow({
    yaml,
    owner: 'a',
    deferLaunch: true
  }, deps);
  await reconcileWorkflow(w, deps);
  expect(k8s.creates).toBe(0);
  expect((await repo.getWorkflow(w.id))?.status).toBe('PENDING');
});
it.each([{
  code: 16,
  policy: 'COMPLETE: "16"',
  phase: 'SUCCEEDED'
}, {
  code: 17,
  policy: 'RESCHEDULE: "17"',
  phase: 'RETRY_WAIT'
}, {
  code: 99,
  policy: 'FAIL: "99"',
  phase: 'FAILED'
}])('applies native exitActions to actual container exit $code', async ({
  code,
  policy,
  phase
}) => {
  const w = await submitWorkflow({
    yaml: yaml + `      retry: { max_retries: 1, backoff_seconds: 2 }\n      exitActions: { ${policy} }\n`,
    owner: 'a'
  }, deps);
  const t = (await repo.listTasks(w.id))[0];
  k8s.fail(t.jobName!);
  k8s.pods = [{
    metadata: {
      name: 'exit',
      labels: {
        'job-name': t.jobName!
      }
    },
    spec: {
      containers: []
    },
    status: {
      phase: 'Failed',
      containerStatuses: [{
        name: 'main',
        ready: false,
        restartCount: 0,
        state: {
          terminated: {
            exitCode: code
          }
        }
      }]
    }
  }];
  // Model synchronous garbage collection only when deletion is requested.
  const del = k8s.deleteJob.bind(k8s);
  k8s.deleteJob = async (ns, name) => {
    await del(ns, name);
    k8s.pods = [];
  };
  await reconcileWorkflow(w, deps);
  expect((await repo.listTasks(w.id))[0].phase).toBe(phase);
  if (phase === 'RETRY_WAIT') {
    await vi.advanceTimersByTimeAsync(2000);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(2);
  }
});
it('does not let one replica COMPLETE override a different replica FAIL policy', async () => {
  const w = await submitWorkflow({
    yaml: yaml + '      parallelism: 2\n      exitActions: { COMPLETE: "16", FAIL: "17" }\n',
    owner: 'a'
  }, deps);
  const t = (await repo.listTasks(w.id))[0];
  k8s.fail(t.jobName!);
  k8s.pods = [16, 17].map(code => ({
    metadata: {
      name: `exit-${code}`,
      labels: {
        'job-name': t.jobName!
      }
    },
    spec: {
      containers: []
    },
    status: {
      phase: 'Failed',
      containerStatuses: [{
        name: 'main',
        ready: false,
        restartCount: 0,
        state: {
          terminated: {
            exitCode: code
          }
        }
      }]
    }
  }));
  const del = k8s.deleteJob.bind(k8s);
  k8s.deleteJob = async (ns, name) => {
    await del(ns, name);
    k8s.pods = [];
  };
  expect((await reconcileWorkflow(w, deps)).status).toBe('FAILED');
});
it('pins Kubernetes UID at launch and refuses a replacement object with the same name and labels', async () => {
  const create = k8s.createJob.bind(k8s);
  k8s.createJob = async (ns, body) => {
    const j = body as Job;
    j.metadata.uid = 'original';
    await create(ns, j);
  };
  const w = await submitWorkflow({
    yaml,
    owner: 'a'
  }, deps);
  const t = (await repo.listTasks(w.id))[0];
  k8s.jobs.get(t.jobName!)!.metadata.uid = 'replacement';
  k8s.succeed(t.jobName!);
  expect((await reconcileWorkflow(w, deps)).status).not.toBe('SUCCEEDED');
  expect((await repo.listTasks(w.id))[0].message).toMatch(/ownership|attempt/);
});
it('records the retrying principal subject without reattributing the retry to the original owner', async () => {
  const w = await submitWorkflow({
    yaml,
    owner: 'alice',
    ownerSubject: 'sub-alice'
  }, deps);
  k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
  await reconcileWorkflow(w, deps);
  const retried = await retryWorkflow(w.id, 'bob', deps, {
    ownerSubject: 'sub-bob'
  });
  expect(retried.owner).toBe('bob');
  expect(retried.ownerSubject).toBe('sub-bob');
});
it('does not guess an FSx mapping for an unrelated S3 bucket', async () => {
  await repo.putDataset({
    name: 'remote',
    owner: 'a',
    latestVersion: 1,
    tags: [],
    createdAt: 'x',
    updatedAt: 'x'
  });
  await repo.putVersion({
    dataset: 'remote',
    version: 1,
    uri: 's3://unrelated-bucket/datasets/remote/v1/',
    tags: [],
    createdAt: 'x',
    createdBy: 'a'
  });
  await expect(submitWorkflow({
    yaml: yaml + '      inputs: [{ dataset: { name: remote } }]\n',
    owner: 'a',
    deferLaunch: true
  }, deps)).rejects.toThrow(/not reachable/);
});
it('rejects host volumes in project submissions before mutation', async () => {
  await expect(submitWorkflow({
    yaml: yaml + '      volumes: ["/tmp/.X11-unix:/tmp/.X11-unix"]\n',
    owner: 'a',
    projectId: 'p',
    namespace: 'n',
    queue: 'q',
    deferLaunch: true
  }, deps)).rejects.toThrow(/volumes/);
  expect(k8s.creates).toBe(0);
});
