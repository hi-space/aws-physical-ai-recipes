import { expect, it } from 'vitest';
import { workflowSchema } from './schema';
import { compileTask, type CompileContext } from './compile';
import { executionNodeBinding, TRUSTED_NODE_LABEL, TRUSTED_NODE_TAINT, trustedTaskHash, type ExecutionProfilePin } from './execution-profile-policy';
const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/trusted@sha256:' + 'a'.repeat(64);
function fixture() {
  const spec = workflowSchema.parse({ workflow: { name: 'trusted-device', resources: { default: { cpu: 1, memory: '1Gi' } },
    tasks: [{ name: 'check', image, command: ['true'], executionProfile: { id: 'device', version: 1 } }] } });
  const task = spec.workflow.tasks[0];
  const pin: ExecutionProfilePin = { id: 'device', version: 1, projectId: 'p', namespace: 'hyperpod-ns-p', backendId: 'default',
    approvedBy: 'admin-sub', image, contentHash: 'approved', nodes: [{ name: 'trusted-node', uid: 'uid' }],
    nodeBinding: executionNodeBinding('p', 'device'),
    approvedTaskHash: trustedTaskHash(task, spec.workflow.resources.default, 'hyperpod-ns-p'),
    policy: { hostNetwork: true, privileged: true, runAsRoot: true,
      mounts: [{ hostPath: '/dev/robot', mountPath: '/mnt/robot', type: 'CharDevice', readOnly: true }] } };
  const context: CompileContext = { workflowId: 'run', projectId: 'p', namespace: 'hyperpod-ns-p', owner: 'admin',
    queue: 'q', datasetPaths: {}, credentialValues: {}, runtimeImage: 'trusted-runtime', runtimeCommand: '/opt/pai/runtime',
    executionProfile: pin };
  return { spec, task, pin, context };
}
it('requires a trusted matching server pin and preserves the default raw-volume rejection', () => {
  const { spec, task, context } = fixture();
  expect(() => compileTask(spec, task, { ...context, executionProfile: undefined })).toThrow('Trusted execution profile');
  expect(() => compileTask(spec, { ...task, command: ['different'] }, context)).toThrow('Trusted execution profile');
  expect(() => compileTask(spec, { ...task, volumes: ['/host:/mnt/host'] }, context)).toThrow('user volumes');
});
it('compiles only approved host mounts and dedicated node scheduling, disabling ambiguous host-network files', () => {
  const { spec, task, context, pin } = fixture();
  const job = compileTask(spec, task, context).job as any;
  const pod = job.spec.template.spec;
  expect(pod.nodeSelector[TRUSTED_NODE_LABEL]).toBe(pin.nodeBinding);
  expect(pod.tolerations).toContainEqual({ key: TRUSTED_NODE_TAINT, value: pin.nodeBinding, operator: 'Equal', effect: 'NoSchedule' });
  expect(pod.hostNetwork).toBe(true);
  expect(pod.dnsPolicy).toBe('ClusterFirstWithHostNet');
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod.volumes).toContainEqual({ name: 'trusted-host-0', hostPath: { path: '/dev/robot', type: 'CharDevice' } });
  expect(pod.containers[0].securityContext).toMatchObject({ privileged: true, runAsUser: 0, runAsNonRoot: false });
  expect(pod.containers[0].command.slice(0, 2)).toEqual(['/opt/pai/runtime', '--contract']);
  expect(pod.containers[0].command.slice(3, 6)).toEqual(['--', '/bin/sh', '-c']);
  expect(pod.containers[0].env).toContainEqual({ name: 'PAI_RUNTIME_FILES_DISABLED', value: '1' });
  expect(pod.containers[0].ports.some((p: { containerPort: number }) => p.containerPort === 8077)).toBe(false);
  expect(pod.initContainers.some((p: { name: string }) => p.name === 'pai-isolation-ready')).toBe(false);
  expect(pod.initContainers.some((p: { name: string }) => p.name === 'pai-storage-prepare')).toBe(true);
  expect(job.spec.suspend).toBe(true);
});
it('preserves normal project isolation with no trusted profile', () => {
  const { spec, task, context } = fixture();
  delete task.executionProfile;
  const job = compileTask(spec, task, { ...context, executionProfile: undefined }).job as any;
  const pod = job.spec.template.spec;
  expect(pod.hostNetwork).toBeUndefined();
  expect(pod.containers[0].securityContext).toMatchObject({ runAsUser: 1000, allowPrivilegeEscalation: false });
  expect(pod.initContainers.some((p: { name: string }) => p.name === 'pai-isolation-ready')).toBe(true);
  expect(pod.volumes.some((v: { hostPath?: unknown }) => v.hostPath)).toBe(false);
});
