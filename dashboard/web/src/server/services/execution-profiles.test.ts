import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { workflowSchema } from '../workflow/schema';
import type { Project } from '../auth/projects';
import { executionProfilesService, validateExecutionProfile, type ExecutionProfileDeps } from './execution-profiles';
import { approvedOutputNames, executionNodeBinding, executionPolicySchema, TRUSTED_NODE_LABEL, TRUSTED_NODE_TAINT, trustedTaskHash } from '../workflow/execution-profile-policy';

const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/recipes/device@sha256:' + 'a'.repeat(64);
const admin = { user: 'admin', subject: 'admin-sub', email: '', role: 'admin' as const };
const project: Project = { id: 'a', name: 'A', namespace: 'hyperpod-ns-a', queue: 'q-a',
  members: { 'alice-sub': 'researcher' }, credentialRefs: [], createdAt: 'x', updatedAt: 'x' };
const spec = () => workflowSchema.parse({ workflow: { name: 'device-check', resources: { default: { cpu: 1, memory: '1Gi' } },
  tasks: [{ name: 'check', image, command: ['python', '/app/diagnose.py'], outputs: [{ dataset: { name: 'result-{{workflow_id}}', path: '{{output}}' } }] }] } });
const input = () => ({ id: 'device', name: 'Device diagnostic', yaml: JSON.stringify(spec()), taskName: 'check',
  acknowledgeTrustBoundary: true as const, policy: { hostNetwork: true, privileged: false, runAsRoot: false,
    mounts: [{ hostPath: '/dev/robot-diagnostic', mountPath: '/mnt/robot', type: 'CharDevice' as const, readOnly: true }] } });
let d: ExecutionProfileDeps;
beforeEach(async () => {
  const repo = new Repo(new MemoryKV());
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project });
  d = {
    repo, now: () => new Date('2026-09-16T17:00:00Z'),
    currentUser: vi.fn(async () => ({ username: 'admin', subject: 'admin-sub', enabled: true, groups: ['admins'], email: '' })),
    inspectImage: vi.fn(async task => task.image),
    nodes: vi.fn(async () => [{ name: 'dedicated-a', uid: 'node-uid-a', ready: true, unschedulable: false, workloads: [],
      labels: { [TRUSTED_NODE_LABEL]: executionNodeBinding(project.id, 'device'), 'sagemaker.amazonaws.com/node-health-status': 'Schedulable' },
      taints: [{ key: TRUSTED_NODE_TAINT, value: executionNodeBinding(project.id, 'device'), effect: 'NoSchedule' }] }]),
  };
});
describe('trusted execution profile boundary', () => {
  it('stores immutable task, node identity and policy revisions with CAS and revocation', async () => {
    const service = executionProfilesService(admin, d);
    const one = await service.approve(input(), project);
    expect(one).toMatchObject({ version: 1, enabled: true, approvedBy: 'admin-sub', nodes: [{ name: 'dedicated-a', uid: 'node-uid-a' }] });
    const two = await service.approve({ ...input(), expectedVersion: 1, name: 'Revised diagnostic' }, project);
    expect(two.version).toBe(2);
    expect((await service.get('device', project, 1)).name).toBe('Device diagnostic');
    await expect(service.approve({ ...input(), expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 409 });
    await service.disable('device', project, 2);
    expect((await service.get('device', project)).enabled).toBe(false);
  });
  it('denies researchers, API tokens and demoted or disabled browser administrators', async () => {
    await expect(executionProfilesService({ ...admin, role: 'researcher' }, d).approve(input(), project)).rejects.toMatchObject({ status: 403 });
    await expect(executionProfilesService({ ...admin, authMethod: 'token' }, d).approve(input(), project)).rejects.toMatchObject({ status: 403 });
    d.currentUser = vi.fn(async () => ({ username: 'admin', subject: 'admin-sub', enabled: true, groups: ['researchers'], email: '' }));
    await expect(executionProfilesService(admin, d).approve(input(), project)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses generic worker nodes and node identity substitution', async () => {
    const service = executionProfilesService(admin, d);
    const p = await service.approve(input(), project);
    const workflow = spec();
    workflow.workflow.tasks[0].executionProfile = { id: p.id, version: p.version };
    const pins = await service.bind(workflow, project);
    const wf = { id: 'run-one', owner: 'admin', ownerSubject: 'admin-sub', projectId: project.id, namespace: project.namespace,
      spec: workflow, executionProfilePins: pins } as Parameters<typeof validateExecutionProfile>[0];
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).resolves.toBeUndefined();
    const nodes = await d.nodes();
    d.nodes = vi.fn(async () => nodes.map(n => ({ ...n, uid: 'replaced-node' })));
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).rejects.toMatchObject({ status: 409 });
    d.nodes = vi.fn(async () => nodes.map(n => ({ ...n, taints: [] })));
    await expect(service.approve({ ...input(), expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 422 });
    d.nodes = vi.fn(async () => nodes.map(n => ({ ...n, workloads: [{ namespace: project.namespace, phase: 'Running' }] })));
    await expect(service.approve({ ...input(), expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 422 });
  });
  it('pins actual commands, environment, dataset version, resources and policy; rejects changed tasks', async () => {
    const service = executionProfilesService(admin, d);
    const p = await service.approve(input(), project);
    const workflow = spec();
    workflow.workflow.tasks[0].executionProfile = { id: p.id, version: p.version };
    expect(Object.keys(await service.bind(workflow, project))).toEqual(['check']);
    workflow.workflow.tasks[0].args = ['--different'];
    await expect(service.bind(workflow, project)).rejects.toMatchObject({ status: 422 });
    const original = spec().workflow.tasks[0];
    const hashed = trustedTaskHash(original, { cpu: 1 }, project.namespace);
    const materialized = structuredClone(original);
    const output = materialized.outputs[0];
    if ('dataset' in output) output.dataset.name = 'result-run123';
    expect(trustedTaskHash(materialized, { cpu: 1 }, project.namespace, 'run123', approvedOutputNames(original))).toBe(hashed);
    expect(trustedTaskHash(original, { cpu: 2 }, project.namespace)).not.toBe(hashed);
  });
  it('launches only with a still-approved version and current administrator owner', async () => {
    const service = executionProfilesService(admin, d);
    const p = await service.approve(input(), project);
    const workflow = spec(); workflow.workflow.tasks[0].executionProfile = { id: p.id, version: p.version };
    const wf = { id: 'r', owner: admin.user, ownerSubject: admin.subject, projectId: project.id, namespace: project.namespace,
      spec: workflow, executionProfilePins: await service.bind(workflow, project) } as Parameters<typeof validateExecutionProfile>[0];
    await service.disable(p.id, project, p.version);
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects a disabled owner or a rebound project even while the approval head stays enabled', async () => {
    const service = executionProfilesService(admin, d), profile = await service.approve(input(), project);
    const workflow = spec(); workflow.workflow.tasks[0].executionProfile = { id: profile.id, version: profile.version };
    const wf = { id: 'r', owner: admin.user, ownerSubject: admin.subject, projectId: project.id, namespace: project.namespace,
      spec: workflow, executionProfilePins: await service.bind(workflow, project) } as Parameters<typeof validateExecutionProfile>[0];
    const enabledUser = d.currentUser;
    d.currentUser = async username => ({ ...await enabledUser(username), enabled: false });
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).rejects.toMatchObject({ status: 409 });
    d.currentUser = enabledUser;
    await d.repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, namespace: 'hyperpod-ns-rebound' });
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects mutable dataset inputs, implicit trust acknowledgement and dangerous mount aliases', async () => {
    const service = executionProfilesService(admin, d);
    await expect(service.approve({ ...input(), acknowledgeTrustBoundary: false } as never, project)).rejects.toMatchObject({ status: 400 });
    await expect(service.approve({ ...input(), policy: { ...input().policy, mounts: [{ hostPath: '/', mountPath: '/mnt/root', type: 'Directory', readOnly: true }] } }, project)).rejects.toMatchObject({ status: 400 });
    await expect(service.approve({ ...input(), policy: { ...input().policy, mounts: [{ hostPath: '/dev/robot', mountPath: '/opt/pai', type: 'CharDevice', readOnly: true }] } }, project)).rejects.toMatchObject({ status: 400 });
    const mutable = spec(); mutable.workflow.tasks[0].inputs = [{ dataset: { name: 'data', version: 'latest' } }];
    await expect(service.approve({ ...input(), yaml: JSON.stringify(mutable) }, project)).rejects.toMatchObject({ status: 400 });
  });
  it.each(['bind', 'launch'] as const)('honors revocation observed on the second approval-head read during %s', async operation => {
    const service = executionProfilesService(admin, d), profile = await service.approve(input(), project);
    const workflow = spec(); workflow.workflow.tasks[0].executionProfile = { id: profile.id, version: profile.version };
    const pins = await service.bind(workflow, project);
    const wf = { id: 'r', owner: admin.user, ownerSubject: admin.subject, projectId: project.id, namespace: project.namespace,
      spec: workflow, executionProfilePins: pins } as Parameters<typeof validateExecutionProfile>[0];
    const get = d.repo.kv.get.bind(d.repo.kv);
    let headReads = 0;
    d.repo.kv.get = async (pk, sk) => {
      if (sk === 'EXECUTION_PROFILE#device' && ++headReads === 2) {
        const head = await get(pk, sk); await d.repo.kv.put({ ...head!, enabled: false });
      }
      return get(pk, sk);
    };
    await expect(operation === 'bind' ? service.bind(workflow, project) : validateExecutionProfile(wf, workflow.workflow.tasks[0], d))
      .rejects.toMatchObject({ status: 409 });
  });
  it.each(['disable', 'revision', 'user'] as const)('rechecks %s after the final asynchronous node inventory', async change => {
    const service = executionProfilesService(admin, d), profile = await service.approve(input(), project);
    const workflow = spec(); workflow.workflow.tasks[0].executionProfile = { id: profile.id, version: profile.version };
    const wf = { id: 'r', owner: admin.user, ownerSubject: admin.subject, projectId: project.id, namespace: project.namespace,
      spec: workflow, executionProfilePins: await service.bind(workflow, project) } as Parameters<typeof validateExecutionProfile>[0];
    const nodes = await d.nodes();
    d.nodes = async () => {
      if (change === 'user') d.currentUser = async () => ({ username: 'admin', subject: 'admin-sub', enabled: false, groups: ['admins'], email: '' });
      else {
        const head = await d.repo.kv.get('PROJECT#a', 'EXECUTION_PROFILE#device');
        await d.repo.kv.put({ ...head!, ...(change === 'disable' ? { enabled: false } : { version: 2 }) });
      }
      return nodes;
    };
    await expect(validateExecutionProfile(wf, workflow.workflow.tasks[0], d)).rejects.toMatchObject({ status: 409 });
  });
  it('canonicalizes valid placeholder whitespace and preserves literal output names containing the run ID', async () => {
    const source = spec(), output = source.workflow.tasks[0].outputs[0];
    if ('dataset' in output) output.dataset.name = 'result-{{ workflow_id }}';
    const service = executionProfilesService(admin, d), profile = await service.approve({ ...input(), yaml: JSON.stringify(source) }, project);
    source.workflow.tasks[0].executionProfile = { id: profile.id, version: profile.version };
    const wf = { id: '0123456789abcdef', owner: admin.user, ownerSubject: admin.subject, projectId: project.id, namespace: project.namespace,
      spec: source, executionProfilePins: await service.bind(source, project) } as Parameters<typeof validateExecutionProfile>[0];
    if ('dataset' in output) output.dataset.name = `result-${wf.id}`;
    await expect(validateExecutionProfile(wf, source.workflow.tasks[0], d)).resolves.toBeUndefined();
    const literal = structuredClone(source.workflow.tasks[0]);
    const hash = trustedTaskHash(literal, {}, project.namespace);
    expect(trustedTaskHash(literal, {}, project.namespace, wf.id, approvedOutputNames(literal))).toBe(hash);
  });
  it.each(['/var', '/var/lib', '/root/.aws', '/home/ubuntu/.ssh', '/mnt/backup/.kube'])('excludes forbidden roots through %s', hostPath => {
    expect(executionPolicySchema.safeParse({ mounts: [{ hostPath, mountPath: '/mnt/host', type: 'Directory', readOnly: true }] }).success).toBe(false);
  });
});
