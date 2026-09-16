import { expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Job } from '../k8s/resources';
import type { TaskImagePins } from '../store/types';
import { submitWorkflow, retryWorkflow, reconcileWorkflow, type SubmitInput } from './controller';
import type { ControllerDeps, JobSet, K8sPort } from './ports';
import { parseWorkflowYaml } from './template';
import { compileTask } from './compile';

const imageA = `registry.example/cpu@sha256:${'a'.repeat(64)}`;
const imageB = `registry.example/cpu@sha256:${'b'.repeat(64)}`;
const checkedAt = '2026-09-16T01:00:00Z';
const yaml = `workflow:
  name: image-policy
  resources: {cpu: {cpu: 1}}
  tasks:
    - {name: train, resource: cpu, image: 'registry.example/cpu:mutable', command: [echo, ok]}
`;
const grouped = `workflow:
  name: grouped-policy
  resources: {cpu: {cpu: 1}}
  groups:
    - name: workers
      tasks:
        - {name: lead, lead: true, resource: cpu, image: 'registry.example/cpu:mutable', command: [echo, lead]}
        - {name: peer, resource: cpu, image: 'registry.example/cpu:mutable', command: [echo, peer]}
`;
const pin = (image = imageA, profileVersion = 1, time = checkedAt) =>
  ({ image, profileId: 'cpu-approved', profileVersion, checkedAt: time });

function fixture() {
  const repo = new Repo(new MemoryKV()), jobs = new Map<string, Job>(), groups = new Map<string, JobSet>();
  const created: Job[] = [], createdGroups: JobSet[] = [];
  const k8s: K8sPort = {
    getJob: async (_ns, name) => jobs.get(name) ?? null,
    createJob: async (_ns, object) => {
      const job = structuredClone(object) as Job; jobs.set(job.metadata.name, job); created.push(job); return job;
    },
    deleteJob: async (_ns, name) => { jobs.delete(name); },
    listPods: async () => [], queueState: async () => 'admitted',
    ensureNamespace: async () => {}, ensureFsxPvc: async () => {},
    upsertConfigMap: async () => {}, upsertSecret: async () => {}, deleteByLabel: async () => {},
    getJobSet: async (_ns, name) => groups.get(name) ?? null,
    createJobSet: async (_ns, object) => {
      const group = structuredClone(object) as JobSet; groups.set(group.metadata.name, group); createdGroups.push(group); return group;
    },
    deleteJobSet: async (_ns, name) => { groups.delete(name); },
  };
  const deps: ControllerDeps = { repo, k8s, now: () => new Date(checkedAt), notify: async () => {},
    resolveCredential: async () => '', runtimeImage: 'runtime:test', runtimeCommand: '/opt/pai/runtime',
    groupRuntime: { observe: async () => ({ epoch: 'unused', barrierReleased: false, tasks: {} }), fence: async () => {} } };
  const input: SubmitInput = { yaml, owner: 'alice', ownerSubject: 'alice-id', projectId: 'p',
    namespace: 'hyperpod-ns-p', queue: 'project-queue', deferLaunch: true };
  return { repo, jobs, created, createdGroups, deps, input };
}

it('persists trusted image/profile pins before hashing and synchronizes grouped task images', async () => {
  const f = fixture();
  const wf = await submitWorkflow({ ...f.input, yaml: grouped,
    imagePins: { lead: pin(imageA), peer: pin(imageB, 2) },
    preflightReviewedBy: 'alice-id', preflightReviewedAt: checkedAt }, f.deps);
  expect(wf.spec.workflow.tasks.map(task => task.image)).toEqual([imageA, imageB]);
  expect(wf.spec.workflow.groups![0].tasks.map(task => task.image)).toEqual([imageA, imageB]);
  expect(wf.imagePins).toEqual({ lead: pin(imageA), peer: pin(imageB, 2) });
  expect(wf.preflightReviewedBy).toBe('alice-id');
  expect(wf.preflightReviewedAt).toBe(checkedAt);
  const compiled = compileTask(wf.spec, wf.spec.workflow.tasks[0], {
    workflowId: wf.id, projectId: 'p', owner: 'alice', namespace: 'hyperpod-ns-p',
    runtimeImage: 'runtime:test', datasetPaths: {}, credentialValues: {},
  }).job as unknown as Job;
  expect(compiled.spec.template.spec.containers[0].image).toBe(imageA);
  expect(compiled.metadata.labels?.['pai.aws/project']).toBe('p');
  expect(compiled.spec.template.metadata?.labels?.['pai.aws/project']).toBe('p');
});

it('idempotency binds digest and profile revision but not a repeated inspection timestamp', async () => {
  const f = fixture();
  const input = { ...f.input, idempotencyKey: 'reviewed', imagePins: { train: pin() },
    preflightReviewedBy: 'alice-id', preflightReviewedAt: checkedAt };
  const first = await submitWorkflow(input, f.deps);
  const again = await submitWorkflow({ ...input, imagePins: { train: pin(imageA, 1, '2026-09-16T02:00:00Z') },
    preflightReviewedAt: '2026-09-16T02:00:00Z' }, f.deps);
  expect(again.id).toBe(first.id);
  expect(again.imagePins?.train.checkedAt).toBe(checkedAt);
  await expect(submitWorkflow({ ...input, imagePins: { train: pin(imageB) } }, f.deps)).rejects.toMatchObject({ status: 409 });
  await expect(submitWorkflow({ ...input, imagePins: { train: pin(imageA, 2) } }, f.deps)).rejects.toMatchObject({ status: 409 });
});

it('normalizes grouped image bindings before hashing even when requested mutable tags change', async () => {
  const f = fixture();
  const input = { ...f.input, yaml: grouped, idempotencyKey: 'group-image-pins',
    imagePins: { lead: pin(), peer: pin(imageB, 2) } };
  const first = await submitWorkflow(input, f.deps);
  const same = await submitWorkflow({ ...input, yaml: grouped.replaceAll('cpu:mutable', 'cpu:different-tag') }, f.deps);
  expect(same.id).toBe(first.id);
  expect(same.specHash).toBe(first.specHash);
});

it('copies trusted metadata and leaves unpinned tasks unchanged without inherited-key lookups', async () => {
  const f = fixture();
  const pins = { train: pin() };
  const workflow = await submitWorkflow({ ...f.input,
    yaml: yaml + "    - {name: constructor, resource: cpu, image: legacy:tag, command: [echo, legacy]}\n",
    imagePins: pins }, f.deps);
  pins.train.image = imageB;
  expect(workflow.imagePins?.train.image).toBe(imageA);
  expect(workflow.spec.workflow.tasks.find(task => task.name === 'constructor')?.image).toBe('legacy:tag');
});

it('manual retry preserves the immutable task image and profile/review metadata', async () => {
  const f = fixture();
  f.deps.enqueueWorkflow = async () => {};
  const first = await submitWorkflow({ ...f.input, imagePins: { train: pin() },
    preflightReviewedBy: 'alice-id', preflightReviewedAt: checkedAt }, f.deps);
  await f.repo.putWorkflow({ ...first, status: 'FAILED' });
  const retried = await retryWorkflow(first.id, 'alice', f.deps, { ownerSubject: 'alice-id' });
  expect(retried.id).not.toBe(first.id);
  expect(retried.spec.workflow.tasks[0].image).toBe(imageA);
  expect(retried.imagePins).toEqual(first.imagePins);
  expect(retried.preflightReviewedBy).toBe(first.preflightReviewedBy);
  expect(retried.preflightReviewedAt).toBe(first.preflightReviewedAt);
});

it('rejects malformed trusted bindings and keeps YAML/client metadata out of the workflow schema', async () => {
  const f = fixture();
  const invalid: TaskImagePins[] = [
    { unknown: pin() }, { train: pin('registry.example/cpu:mutable') },
    { train: pin(imageA, 0) }, { train: pin(imageA, 1, 'not-a-date') },
  ];
  for (const imagePins of invalid) await expect(submitWorkflow({ ...f.input, imagePins }, f.deps)).rejects.toThrow();
  for (const field of ['imagePins: {}', 'preflightReviewedBy: attacker', 'preflightReviewedAt: now']) {
    expect(() => parseWorkflowYaml(yaml.replace('  name: image-policy', `  name: image-policy\n  ${field}`))).toThrow();
  }
  const legacy = await submitWorkflow(f.input, f.deps);
  expect(legacy.imagePins).toBeUndefined();
  expect(legacy.spec.workflow.tasks[0].image).toBe('registry.example/cpu:mutable');
});

it('rechecks policy immediately before creation and creates nothing when approval is revoked', async () => {
  const f = fixture();
  const calls: string[] = [];
  f.deps.k8s.upsertSecret = async () => { calls.push('secret'); };
  f.deps.runtimeEnvironment = () => ({ PAI_RUNTIME_TOKEN: 'fixture-token' });
  const create = f.deps.k8s.createJob;
  f.deps.k8s.createJob = async (...args) => { calls.push('create'); return create(...args); };
  let revoked = true;
  f.deps.validateTaskPolicy = async (wf, task) => {
    calls.push('policy');
    expect(task.image).toBe(imageA);
    expect(wf.imagePins?.[task.name].profileVersion).toBe(1);
    if (revoked) throw new Error('image approval revoked');
  };
  const wf = await submitWorkflow({ ...f.input, imagePins: { train: pin() } }, f.deps);
  await reconcileWorkflow(wf, f.deps);
  expect(f.created).toHaveLength(0);
  expect((await f.repo.listTasks(wf.id))[0].message).toContain('image approval revoked');
  revoked = false;
  await reconcileWorkflow((await f.repo.getWorkflow(wf.id))!, f.deps);
  expect(f.created).toHaveLength(1);
  expect(calls.slice(-2)).toEqual(['policy', 'create']);
  const checks = calls.filter(value => value === 'policy').length;
  // Adoption is observation, not a new workload launch.
  const task = (await f.repo.listTasks(wf.id))[0];
  await f.repo.putTask({ ...task, phase: 'LAUNCHING' });
  revoked = true;
  await reconcileWorkflow((await f.repo.getWorkflow(wf.id))!, f.deps);
  expect(f.created).toHaveLength(1);
  expect(calls.filter(value => value === 'policy')).toHaveLength(checks);
});

it('validates every JobSet member and blocks the whole create when any member fails policy', async () => {
  const f = fixture();
  const checked: string[] = [];
  f.deps.validateTaskPolicy = async (_wf, task) => {
    checked.push(task.name);
    if (task.name === 'peer') throw new Error('peer profile disabled');
  };
  const wf = await submitWorkflow({ ...f.input, yaml: grouped,
    imagePins: { lead: pin(), peer: pin(imageB, 2) } }, f.deps);
  await reconcileWorkflow(wf, f.deps);
  expect(checked).toEqual(['lead', 'peer']);
  expect(f.created).toHaveLength(0);
  expect(f.createdGroups).toHaveLength(0);
});
