import { expect, it } from 'vitest';
import { parseWorkflowYaml } from './template';
import { compileTask } from './compile';
const base = `workflow:
  name: checks
  resources: { cpu: { cpu: 1 } }
  tasks:
    - name: a
      resource: cpu
      image: busybox
      command: [echo, ok]
`;
it('normalizes native groups into tasks and retains explicit group semantics', () => {
  const y = `workflow:
  name: grouped
  resources: { cpu: { cpu: 1 } }
  groups:
    - name: pair
      barrier: true
      ignoreNonleadStatus: false
      timeout: { exec: 1h, queue: 10m, start: 2m }
      tasks:
        - { name: leader, lead: true, resource: cpu, image: python, command: [echo, lead] }
        - name: worker
          resource: cpu
          image: python
          command: [echo, work]
          exitActions: { COMPLETE: "0", RESCHEDULE: "11-20" }
          checkpoint: [{ path: /tmp/checkpoint, url: 's3://b/checkpoints/', frequency: 30m }]
`;
  const {
    spec
  } = parseWorkflowYaml(y);
  expect(spec.workflow.tasks.map(t => t.name)).toEqual(['leader', 'worker']);
  expect(spec.workflow.groups?.[0]).toMatchObject({
    name: 'pair',
    barrier: true,
    ignoreNonleadStatus: false
  });
  expect(spec.workflow.tasks[1].exitActions?.RESCHEDULE).toBe('11-20');
});
it.each(['/tmp/../escape', '/tmp/a\'bad', '/pai/files/runtime', '/proc/self/environ'])('rejects unsafe injection path %s', path => {
  expect(() => parseWorkflowYaml(base + `      files: [{ path: ${JSON.stringify(path)}, contents: x }]\n`)).toThrow(/path|reserved/);
});
it('rejects compiler environment overrides including credential mapping', () => {
  expect(() => parseWorkflowYaml(base + '      environment: { PAI_WORKFLOW_ID: other }\n')).toThrow(/reserved/);
  expect(() => parseWorkflowYaml(base + '      credentials: { c: { OSMO_TASK_NAME: /pai/key } }\n')).toThrow(/reserved/);
});
it('rejects overlapping exit ranges and leader designation without a group', () => {
  expect(() => parseWorkflowYaml(base + '      exitActions: { COMPLETE: "0-10", FAIL: "10-20" }\n')).toThrow(/overlap/);
  expect(() => parseWorkflowYaml(base + '      lead: true\n')).toThrow(/group/);
});
it('does not reuse output paths or Kubernetes names between attempts', () => {
  const {
    spec
  } = parseWorkflowYaml(base);
  const a = compileTask(spec, spec.workflow.tasks[0], {
    workflowId: 'run',
    projectId: 'p',
    runtimeImage: 'trusted/runtime:fixed',
    attempt: 1,
    owner: 'a',
    namespace: 'n',
    datasetPaths: {},
    credentialValues: {}
  });
  const b = compileTask(spec, spec.workflow.tasks[0], {
    workflowId: 'run',
    projectId: 'p',
    runtimeImage: 'trusted/runtime:fixed',
    attempt: 2,
    owner: 'a',
    namespace: 'n',
    datasetPaths: {},
    credentialValues: {}
  });
  expect(a.outputPath).toBe('/fsx/checkpoints/projects/p/runs/run/attempts/1/a');
  expect(a.outputPath).not.toBe(b.outputPath);
  expect(a.jobName).not.toBe(b.jobName);
  expect((b.job as any).spec.backoffLimit).toBe(0);
});
it('accepts native resource topology, excluded nodes and default resource while preserving topology groups', () => {
  const {
    spec
  } = parseWorkflowYaml(`workflow:
  name: topology
  resources:
    default:
      cpu: 1
      nodesExcluded: [bad-node]
      topology: [{ key: rack, group: trainers, requirementType: preferred }]
  tasks:
    - { name: a, image: busybox, command: [echo, a] }
`);
  expect(spec.workflow.tasks[0].resource).toBe('default');
  expect(spec.workflow.resources.default.topology?.[0]).toEqual({
    key: 'rack',
    group: 'trainers',
    requirementType: 'preferred'
  });
});
it('rejects cycles introduced by contracting concurrent groups into admission units', () => {
  expect(() => parseWorkflowYaml(`workflow:
  name: cyclic-groups
  resources: { cpu: {cpu: 1} }
  groups:
    - name: ga
      tasks:
        - { name: a1, lead: true, image: busybox, command: [true], resource: cpu, inputs: [{task: b1}] }
        - { name: a2, image: busybox, command: [true], resource: cpu }
    - name: gb
      tasks:
        - { name: b1, lead: true, image: busybox, command: [true], resource: cpu }
        - { name: b2, image: busybox, command: [true], resource: cpu, inputs: [{task: a2}] }
`.replaceAll('[true]', '["true"]'))).toThrow(/cycle/);
});
it('requires an explicit workload command rather than executing an empty shell successfully', () => {
  expect(() => parseWorkflowYaml(base.replace('      command: [echo, ok]\n', ''))).toThrow(/command/);
});
it('mounts only project workspaces and read-only pinned inputs in a non-root tokenless workload', () => {
  const {
    spec
  } = parseWorkflowYaml(base + '      inputs: [{ dataset: { name: demos, path: /data } }]\n');
  const compiled = compileTask(spec, spec.workflow.tasks[0], {
    workflowId: 'r',
    projectId: 'robotics',
    attempt: 1,
    owner: 'a',
    namespace: 'n',
    runtimeImage: 'trusted/runtime:fixed',
    datasetPaths: {
      demos: '/fsx/datasets/projects/robotics/demos/v3'
    },
    credentialValues: {}
  });
  const pod = (compiled.job as any).spec.template.spec,
    main = pod.containers[0];
  expect(main.volumeMounts).not.toContainEqual(expect.objectContaining({
    mountPath: '/fsx'
  }));
  expect(main.volumeMounts).toContainEqual({
    name: 'fsx',
    mountPath: '/fsx/checkpoints/projects/robotics',
    subPath: 'checkpoints/projects/robotics'
  });
  expect(main.volumeMounts).toContainEqual({
    name: 'fsx',
    mountPath: '/fsx/datasets/projects/robotics',
    subPath: 'datasets/projects/robotics',
    readOnly: true
  });
  expect(main.volumeMounts).toContainEqual({
    name: 'fsx',
    mountPath: '/data',
    subPath: 'datasets/projects/robotics/demos/v3',
    readOnly: true
  });
  expect(main.volumeMounts.some((m: {
    mountPath: string;
  }) => m.mountPath === '/fsx/envs' || m.mountPath === '/fsx/workshop')).toBe(false);
  expect(main.securityContext).toMatchObject({
    runAsUser: 1000,
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    capabilities: {
      drop: ['ALL']
    }
  });
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod.serviceAccountName).toBe('pai-workload');
  const init = pod.initContainers.find((c: {
    name: string;
  }) => c.name === 'pai-storage-prepare');
  expect(init.image).toBe('trusted/runtime:fixed');
  expect(init.volumeMounts).toEqual([{
    name: 'fsx',
    mountPath: '/pai-fsx'
  }]);
  expect(init.command.join(' ')).toContain('checkpoints/projects/robotics');
});
it('allows shared FSx env/workshop mounts only as explicit read-only trusted compiler context', () => {
  const {
    spec
  } = parseWorkflowYaml(base);
  const ctx = {
    workflowId: 'r',
    projectId: 'p',
    owner: 'a',
    namespace: 'n',
    runtimeImage: 'trusted/runtime:fixed',
    datasetPaths: {},
    credentialValues: {},
    sharedReadOnlyPaths: ['envs', 'workshop'] as ('envs' | 'workshop')[]
  };
  const pod = (compileTask(spec, spec.workflow.tasks[0], ctx).job as any).spec.template.spec;
  for (const path of ['envs', 'workshop']) expect(pod.containers[0].volumeMounts).toContainEqual({
    name: 'fsx',
    mountPath: `/fsx/${path}`,
    subPath: path,
    readOnly: true
  });
});
it('rejects compiler input mounts into another project and injection into the trusted runtime directory', () => {
  const {
    spec
  } = parseWorkflowYaml(base + '      inputs: [{ dataset: { name: d } }]\n');
  expect(() => compileTask(spec, spec.workflow.tasks[0], {
    workflowId: 'r',
    projectId: 'p',
    owner: 'a',
    namespace: 'n',
    runtimeImage: 'trusted/runtime:fixed',
    datasetPaths: {
      d: '/fsx/datasets/projects/other/d'
    },
    credentialValues: {}
  })).toThrow(/project/);
  expect(() => parseWorkflowYaml(base + '      files: [{ path: /opt/pai/runtime, contents: replacement }]\n')).toThrow(/reserved/);
});
