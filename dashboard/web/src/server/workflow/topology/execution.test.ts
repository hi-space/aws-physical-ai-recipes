import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryKV } from '../../store/dynamo';
import { Repo } from '../../store/repo';
import type { Job, Pod } from '../../k8s/resources';
import { reconcileWorkflow, submitWorkflow, type ControllerDeps, type JobSet, type K8sPort } from '../controller';
import type { TopologyInventory } from './types';
class Cluster implements K8sPort {
  roots = new Map<string, JobSet>(); pods: Pod[] = []; creates = 0; failDelete = false; loseReply = false;
  async getJob(_ns: string, _name: string): Promise<Job | null> { return null; }
  async listPods(_ns: string, selector: string) { return this.pods.filter(p => selector.split(',').every(term => { const [k, v] = term.split('='); return p.metadata.labels?.[k] === v; })); }
  async createJob(_ns: string, _job: unknown): Promise<void> { throw new Error('independent Jobs are forbidden'); }
  async deleteJob() {}
  async ensureNamespace() {} async ensureFsxPvc() {} async upsertConfigMap() {} async upsertSecret() {} async deleteByLabel() {}
  async queueState() { return 'pending' as const; }
  async getJobSet(_ns: string, name: string) { return this.roots.get(name) ?? null; }
  async createJobSet(_ns: string, object: unknown) {
    const root = structuredClone(object as JobSet); this.creates++; this.roots.set(root.metadata.name, root);
    if (this.loseReply) throw new Error('lost reply');
  }
  async deleteJobSet(_ns: string, name: string) { if (this.failDelete) throw new Error('delete unavailable'); this.roots.delete(name); }
}
const yaml = `workflow:
  name: topo
  namespace: n
  queue: q
  resources:
    r: { cpu: 2, topology: [{key: zone}, {key: rack}] }
  groups:
    - name: g
      retry: { max_retries: 1, backoff_seconds: 10 }
      tasks:
        - {name: leader, resource: r, lead: true, image: busybox, command: ["true"]}
        - {name: worker, resource: r, image: busybox, command: ["true"]}
`;
let repo: Repo, cluster: Cluster, deps: ControllerDeps, current: TopologyInventory;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
  current = { namespace: 'n', queue: 'q', revision: '1', observedAt: new Date().toISOString(),
    levels: [{ key: 'zone', label: 'topology.kubernetes.io/zone' }, { key: 'rack', label: 'fabric/rack' }],
    nodes: ['n1', 'n2', 'n3', 'n4'].map((name, index) => ({ name, uid: name + '-uid',
      labels: { 'sagemaker.amazonaws.com/node-health-status': 'Schedulable', 'topology.kubernetes.io/zone': 'z1', 'fabric/rack': index < 2 ? 'r1' : 'r2' },
      ready: true, available: { cpu: 2, pods: 10 }, taints: [] })) };
  repo = new Repo(new MemoryKV()); cluster = new Cluster();
  deps = { repo, k8s: cluster, now: () => new Date(), notify: async () => {}, resolveCredential: async () => '', runtimeCommand: '/runtime',
    topologyInventory: vi.fn(async () => ({ ...structuredClone(current), observedAt: new Date().toISOString() })),
    groupRuntime: { observe: vi.fn(async (_wf, _group, epoch) => ({ epoch, barrierReleased: false, tasks: {} })), fence: vi.fn(async () => {}) },
  };
});
afterEach(() => vi.useRealTimers());
it.each(['required', 'preferred'])('rejects standalone task topology (%s) before persisting even a deferred submission', async mode => {
  const single = `workflow:
  name: single
  namespace: n
  queue: q
  resources: { r: { cpu: 2 } }
  tasks:
    - name: task
      resource: r
      image: busybox
      command: ["true"]
      topology: { key: topology.kubernetes.io/zone, mode: ${mode} }
`;
  const outcome = await submitWorkflow({ yaml: single, owner: 'alice', idempotencyKey: 'task-topology', deferLaunch: true }, deps)
    .then(() => undefined, error => error);
  expect(await repo.listWorkflows()).toEqual([]);
  expect(outcome).toMatchObject({ status: 400, message: expect.stringMatching(/topology.*JobSet.*resource/i) });
  expect(cluster.roots.size).toBe(0);
});
describe('durable native topology execution', () => {
  it('persists the placement before create and adopts the same plan after a lost reply', async () => {
    const create = cluster.createJobSet.bind(cluster);
    cluster.createJobSet = async (ns, object) => {
      const root = object as JobSet, task = (await repo.listTasks(root.metadata.labels!['pai.aws/workflow-id']))[0];
      expect(task.topologyPlan?.hash).toBe(root.metadata.annotations?.['pai.aws/topology-plan']);
      expect(task.phase).toBe('LAUNCHING');
      return create(ns, object);
    };
    cluster.loseReply = true;
    const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
    const first = (await repo.listTasks(wf.id))[0];
    expect(first.topologyPlan).toBeDefined();
    await repo.putTask({ ...first, phase: 'LAUNCHING' });
    const second = (await repo.listTasks(wf.id))[1]; await repo.putTask({ ...second, phase: 'LAUNCHING' });
    await reconcileWorkflow(wf, deps);
    expect(cluster.creates).toBe(1);
    expect((await repo.listTasks(wf.id))[0].topologyPlan?.hash).toBe(first.topologyPlan?.hash);
  });
  it('node failure waits for confirmed group deletion and backoff, then replans a new fenced epoch', async () => {
    const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
    const first = (await repo.listTasks(wf.id))[0];
    const root = cluster.roots.get(first.jobName!)!; expect(root).toBeDefined(); root.spec.suspend = false;
    cluster.pods = root.spec.replicatedJobs.map((j, index) => ({ metadata: { name: `pod${index}`, labels: j.template.spec.template.metadata!.labels },
      spec: { containers: [], nodeName: `n${index + 1}` }, status: { phase: 'Running' } }));
    current.nodes[0].ready = false; cluster.failDelete = true;
    await reconcileWorkflow(wf, deps);
    expect((await repo.listTasks(wf.id))[0]).toMatchObject({ phase: 'CANCELLING', topologyDiagnostics: { issue: expect.stringContaining('n1') } });
    expect(deps.groupRuntime!.fence).toHaveBeenCalledWith(expect.objectContaining({ id: wf.id }), 'g', first.attemptEpoch, expect.any(AbortSignal));
    expect(deps.groupRuntime!.observe).not.toHaveBeenCalled();
    cluster.failDelete = false;
    await reconcileWorkflow(wf, deps); expect((await repo.listTasks(wf.id))[0].phase).toBe('CANCELLING');
    cluster.pods = []; await reconcileWorkflow(wf, deps);
    expect((await repo.listTasks(wf.id))[0].phase).toBe('RETRY_WAIT');
    expect(cluster.creates).toBe(1);
    vi.advanceTimersByTime(11000); await reconcileWorkflow(wf, deps);
    const next = (await repo.listTasks(wf.id))[0];
    expect(next.attempts).toBe(2); expect(next.attemptEpoch).not.toBe(first.attemptEpoch);
    expect(next.topologyPlan?.tasks.leader.required['fabric/rack']).toBe('r2');
    expect(cluster.creates).toBe(2);
  });
  it('unsatisfiable required constraints create no workload and remain pending with evidence until deadline', async () => {
    current.nodes = [current.nodes[0], current.nodes[2]];
    const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
    expect(cluster.creates).toBe(0);
    expect((await repo.listTasks(wf.id))[0]).toMatchObject({ phase: 'LAUNCHING', message: expect.stringContaining('NO_FIT') });
    current.nodes[1].labels['fabric/rack'] = 'r1';
    await reconcileWorkflow(wf, deps);
    expect(cluster.creates).toBe(1);
  });
  it('reports real pending scheduler diagnostics and rejects actual placement outside the hard domain', async () => {
    const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
    const first = (await repo.listTasks(wf.id))[0], root = cluster.roots.get(first.jobName!)!;
    root.spec.suspend = false;
    cluster.pods = [{ metadata: { name: 'pending', labels: root.spec.replicatedJobs[0].template.spec.template.metadata!.labels },
      spec: { containers: [] }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }] } }];
    await reconcileWorkflow(wf, deps);
    expect((await repo.listTasks(wf.id))[0].topologyDiagnostics?.pods[0].message).toContain('Insufficient cpu');
    cluster.pods[0].spec.nodeName = 'n3';
    await reconcileWorkflow(wf, deps);
    expect((await repo.listTasks(wf.id))[0].topologyDiagnostics?.issue).toContain('outside');
    expect((await repo.listTasks(wf.id))[0].phase).toBe('CANCELLING');
  });
});
it('never rolls a newly persisted retry placement back after a create transport failure', async () => {
  const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
  const first = (await repo.listTasks(wf.id))[0];
  current.nodes[0].ready = false; current.nodes[1].ready = false;
  await reconcileWorkflow(wf, deps);
  expect((await repo.listTasks(wf.id))[0].phase).toBe('RETRY_WAIT');
  cluster.createJobSet = async () => { throw new Error('create transport unavailable'); };
  vi.advanceTimersByTime(11000); await reconcileWorkflow(wf, deps);
  const retry = (await repo.listTasks(wf.id))[0];
  expect(retry.phase).toBe('LAUNCHING'); expect(retry.attempts).toBe(2);
  expect(retry.topologyPlan?.epoch).toBe(retry.attemptEpoch);
  expect(retry.topologyPlan?.hash).not.toBe(first.topologyPlan?.hash);
  expect(retry.message).toContain('transport unavailable');
});
it('does not accept a webhook or admission update that removes a hard constraint', async () => {
  const wf = await submitWorkflow({ yaml, owner: 'alice' }, deps);
  const first = (await repo.listTasks(wf.id))[0], root = cluster.roots.get(first.jobName!)!;
  delete (root.spec.replicatedJobs[0].template.spec.template.spec as any).affinity;
  await reconcileWorkflow(wf, deps);
  expect(deps.groupRuntime!.observe).not.toHaveBeenCalled();
  expect((await repo.listTasks(wf.id))[0]).toMatchObject({ phase: 'CANCELLING', message: expect.stringContaining('no longer enforces') });
});
it('uses the same fenced placement for a standalone indexed task and admits through its Job queue', async () => {
  const single = `workflow:
  name: single
  namespace: n
  queue: q
  resources: { r: { cpu: 2, topology: [{key: rack}] } }
  tasks: [{name: task, resource: r, image: busybox, parallelism: 2, command: ["true"]}]
`;
  let job: Job | null = null;
  cluster.getJob = async () => job;
  cluster.createJob = async (_ns, body) => { job = structuredClone(body as Job); };
  const wf = await submitWorkflow({ yaml: single, owner: 'alice' }, deps);
  const task = (await repo.listTasks(wf.id))[0];
  expect(task.topologyPlan?.witness).toHaveLength(2);
  expect((job as Job | null)?.spec.suspend).toBe(true);
  expect((job as Job | null)?.metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
  expect((job as Job | null)?.metadata.annotations?.['pai.aws/topology-plan']).toBe(task.topologyPlan?.hash);
});
it('bounds unsatisfied native placement by queue deadlines, retry count and backoff', async () => {
  current.nodes = [current.nodes[0], current.nodes[2]];
  const bounded = yaml.replace('      retry:', '      timeout: {queue: 1s}\n      retry:');
  const wf = await submitWorkflow({ yaml: bounded, owner: 'alice' }, deps);
  vi.advanceTimersByTime(1100); await reconcileWorkflow(wf, deps);
  expect((await repo.listTasks(wf.id))[0].phase).toBe('RETRY_WAIT');
  await reconcileWorkflow(wf, deps);
  expect((await repo.listTasks(wf.id))[0].attempts).toBe(1);
  vi.advanceTimersByTime(11000); await reconcileWorkflow(wf, deps);
  expect((await repo.listTasks(wf.id))[0]).toMatchObject({ attempts: 2, phase: 'LAUNCHING' });
  vi.advanceTimersByTime(1100); await reconcileWorkflow(wf, deps);
  expect((await repo.getWorkflow(wf.id))?.status).toBe('FAILED');
  expect(cluster.creates).toBe(0);
});
