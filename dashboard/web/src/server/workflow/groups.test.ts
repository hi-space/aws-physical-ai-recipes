import { expect, it } from 'vitest';
import { parseWorkflowYaml, specToYaml } from './template';
import { compileGroup } from './groups';
const text = `workflow:
  name: g
  resources: { cpu: { cpu: 1 } }
  groups:
    - name: pair
      ignoreNonleadStatus: false
      tasks:
        - { name: leader, lead: true, resource: cpu, image: python, command: [echo, lead] }
        - { name: worker, resource: cpu, image: python, command: [echo, work] }
`;
it('compiles a group as one admission root with fenced replicas and explicit barrier runtime', () => {
  const {
    spec
  } = parseWorkflowYaml(text);
  const group = compileGroup(spec, spec.workflow.groups![0], {
    workflowId: 'r',
    owner: 'a',
    namespace: 'n',
    queue: 'q',
    attempt: 2,
    credentialValues: {},
    datasetPaths: {},
    runtimeCommand: '/pai-runtime'
  }, 'epoch');
  expect(group.jobSet.kind).toBe('JobSet');
  expect(group.jobSet.metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
  expect(group.jobSet.spec.suspend).toBe(true);
  expect(group.jobSet.spec.failurePolicy).toEqual({
    maxRestarts: 0
  });
  for (const child of group.jobSet.spec.replicatedJobs) {
    // HyperPod validates every batch Job's queue label, including JobSet children.
    expect(child.template.metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
    expect(child.template.spec.template.metadata?.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
    expect(child.template.spec.suspend).toBeUndefined();
    expect(child.template.spec.backoffLimit).toBe(0);
    expect(child.template.spec.template.metadata?.labels?.['pai.aws/epoch']).toBe('epoch');
    expect(child.template.spec.template.spec.containers[0].command?.join(' ')).toContain('/pai-runtime');
  }
});
it.each(['required', 'preferred'] as const)('preserves %s task topology on the corresponding JobSet child', mode => {
  const source = text.replace('lead: true,', `lead: true, topology: {key: topology.kubernetes.io/zone, mode: ${mode}},`);
  const { spec } = parseWorkflowYaml(specToYaml(parseWorkflowYaml(source).spec));
  const result = compileGroup(spec, spec.workflow.groups![0], {
    workflowId: 'r', owner: 'a', namespace: 'n', queue: 'q',
    credentialValues: {}, datasetPaths: {}, runtimeCommand: '/pai-runtime',
  }, 'epoch');
  const [leader, worker] = result.jobSet.spec.replicatedJobs;
  expect(leader.template.spec.template.metadata?.annotations?.[`kueue.x-k8s.io/podset-${mode}-topology`])
    .toBe('topology.kubernetes.io/zone');
  expect(worker.template.spec.template.metadata?.annotations?.[`kueue.x-k8s.io/podset-${mode}-topology`]).toBeUndefined();
  expect(result.jobSet.spec.suspend).toBe(true);
  expect(result.jobSet.metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
});
it('preserves group topology precedence over task topology on every JobSet child', () => {
  const source = text
    .replace('name: pair', 'name: pair\n      topology: {key: topology.kubernetes.io/zone, mode: required}')
    .replace('lead: true,', 'lead: true, topology: {key: kubernetes.io/hostname, mode: preferred},');
  const { spec } = parseWorkflowYaml(source);
  const result = compileGroup(spec, spec.workflow.groups![0], {
    workflowId: 'r', owner: 'a', namespace: 'n', queue: 'q',
    credentialValues: {}, datasetPaths: {}, runtimeCommand: '/pai-runtime',
  }, 'epoch');
  for (const child of result.jobSet.spec.replicatedJobs) {
    expect(child.template.spec.template.metadata?.annotations?.['kueue.x-k8s.io/podset-required-topology'])
      .toBe('topology.kubernetes.io/zone');
    expect(child.template.spec.template.metadata?.annotations?.['kueue.x-k8s.io/podset-preferred-topology']).toBeUndefined();
  }
});
it('keeps generated JobSet child Job and Pod names within Kubernetes DNS limits', () => {
  const {
    spec
  } = parseWorkflowYaml(text.replace('name: pair', 'name: ' + 'g'.repeat(30)).replace('name: leader', 'name: ' + 'l'.repeat(40)));
  const group = compileGroup(spec, spec.workflow.groups![0], {
    workflowId: '0123456789abcdef',
    owner: 'a',
    namespace: 'n',
    attempt: 10,
    credentialValues: {},
    datasetPaths: {},
    runtimeCommand: '/runtime'
  }, 'epoch');
  for (const child of group.jobSet.spec.replicatedJobs) expect(`${group.jobSet.metadata.name}-${child.name}-0-0`.length).toBeLessThanOrEqual(63);
});
it('injects a trusted runtime binary through an init container without depending on the workload image', () => {
  const {
    spec
  } = parseWorkflowYaml(text);
  const group = compileGroup(spec, spec.workflow.groups![0], {
    workflowId: 'r',
    owner: 'a',
    namespace: 'n',
    attempt: 3,
    epoch: 'epoch',
    credentialValues: {},
    datasetPaths: {},
    runtimeImage: 'trusted.ecr/runtime@sha256:abc',
    runtimeEnvironment: {
      PAI_RUNTIME_ENDPOINT: 'http://controller/runtime',
      PAI_RUNTIME_TOKEN: 'signed-fixture'
    }
  }, 'epoch');
  for (const child of group.jobSet.spec.replicatedJobs) {
    const pod = child.template.spec.template.spec as any;
    expect(pod.initContainers).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'pai-runtime-install',
      image: 'trusted.ecr/runtime@sha256:abc',
      command: ['/bin/cp', '/opt/pai/runtime', '/pai-runtime/runtime']
    })]));
    expect(pod.volumes).toContainEqual({
      name: 'pai-runtime',
      emptyDir: {}
    });
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: 'pai-runtime',
      mountPath: '/opt/pai',
      readOnly: true
    });
    expect(pod.containers[0].command.join(' ')).toContain('/opt/pai/runtime');
    expect(pod.containers[0].env).toContainEqual({
      name: 'PAI_RUNTIME_TOKEN',
      valueFrom: { secretKeyRef: { name: `wf-r-${child.name}-a3-creds`, key: 'PAI_RUNTIME_TOKEN' } }
    });
    expect(JSON.stringify(pod)).not.toContain('signed-fixture');
    expect(pod.containers[0].env).toContainEqual({
      name: 'PAI_REPLICA_INDEX',
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']"
        }
      }
    });
    expect(child.template.spec.completionMode).toBe('Indexed');
  }
});
