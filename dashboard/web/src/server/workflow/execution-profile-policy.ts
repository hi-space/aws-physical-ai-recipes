import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { ResourceSpec, TaskSpec } from './schema';

/** NodeRestriction protects this label from kubelet mutation. A separate taint keeps ordinary Jobs away. */
export const TRUSTED_NODE_LABEL = 'pai.aws.node-restriction.kubernetes.io/execution-profile';
export const TRUSTED_NODE_TAINT = 'pai.aws/execution-profile';
const forbiddenRoots = ['/', '/proc', '/sys', '/etc', '/run', '/var/run', '/var/lib/kubelet', '/var/lib/containerd', '/var/lib/docker', '/root', '/home'];
const narrowAbsolute = (value: string) => value.startsWith('/') && value === posix.normalize(value) &&
  !value.includes('\0') && !value.includes('\\') && !value.endsWith('/') && !forbiddenRoots.includes(value) &&
  !forbiddenRoots.slice(1).some(root => value.startsWith(root + '/') || root.startsWith(value + '/')) &&
  !value.split('/').some(part => ['.aws', '.kube', '.ssh', '.azure', '.ngc'].includes(part));
const mountTarget = (value: string) => narrowAbsolute(value) &&
  ['/opt/pai', '/pai', '/fsx', '/dev', '/tmp'].every(root => value !== root && !value.startsWith(root + '/'));
export const executionPolicySchema = z.object({
  hostNetwork: z.boolean().default(false),
  privileged: z.boolean().default(false),
  runAsRoot: z.boolean().default(false),
  mounts: z.array(z.object({
    hostPath: z.string().max(1024).refine(narrowAbsolute, 'Use a narrow host device/data path, excluding system and credential roots'),
    mountPath: z.string().max(1024).refine(mountTarget, 'Mount outside runtime, project data and system paths'),
    type: z.enum(['Directory', 'File', 'Socket', 'CharDevice', 'BlockDevice']),
    readOnly: z.boolean().default(true),
  }).strict()).max(12).default([]),
}).strict().superRefine((value, ctx) => {
  const paths = value.mounts.map(mount => mount.mountPath);
  if (paths.some((path, index) => paths.some((other, j) => j !== index && (path === other || path.startsWith(other + '/'))))) {
    ctx.addIssue({ code: 'custom', message: 'Host mounts cannot overlap' });
  }
});
export type ExecutionPolicy = z.output<typeof executionPolicySchema>;
export interface TrustedNodeIdentity { name: string; uid: string }
export interface ExecutionProfilePin {
  id: string; version: number; projectId: string; namespace: string; backendId: string;
  approvedTaskHash: string; contentHash: string; image: string; policy: ExecutionPolicy;
  nodes: TrustedNodeIdentity[]; nodeBinding: string; approvedBy: string;
  outputNameTemplates?: Record<string, string>;
}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + stableJSON(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const executionHash = (value: unknown) => createHash('sha256').update(stableJSON(value)).digest('hex');
export const executionNodeBinding = (projectId: string, id: string) => `trusted-${executionHash([projectId, id]).slice(0, 24)}`;
const normalizeOutputName = (name: string) => name.replace(/\{\{\s*workflow_id\s*\}\}/g, '{{workflow_id}}');
export const approvedOutputNames = (task: TaskSpec) => Object.fromEntries(task.outputs.flatMap((output, index) =>
  'dataset' in output ? [[String(index), normalizeOutputName(output.dataset.name)]] : []));
export function trustedTaskHash(task: TaskSpec, resource: ResourceSpec, namespace: string, workflowId?: string, outputNames: Record<string, string> = {}): string {
  const { executionProfile: _ref, ...copy } = structuredClone(task);
  for (const [index, output] of copy.outputs.entries()) if ('dataset' in output) {
    output.dataset.name = normalizeOutputName(output.dataset.name);
    const approved = outputNames[String(index)];
    if (workflowId && approved !== undefined && output.dataset.name === normalizeOutputName(approved).replaceAll('{{workflow_id}}', workflowId)) {
      output.dataset.name = normalizeOutputName(approved);
    }
  }
  return executionHash({ task: copy, resource, namespace });
}
/** A pin is trusted server state. Caller YAML contains only the profile id and exact revision. */
export function assertExecutionPin(pin: ExecutionProfilePin | undefined, task: TaskSpec, resource: ResourceSpec, context: {
  projectId?: string; namespace: string; backendId?: string; workflowId?: string;
}): asserts pin is ExecutionProfilePin {
  if (!pin || !task.executionProfile || task.executionProfile.id !== pin.id || task.executionProfile.version !== pin.version ||
    pin.projectId !== context.projectId || pin.namespace !== context.namespace || pin.backendId !== (context.backendId ?? 'default') ||
    pin.image !== task.image || pin.approvedTaskHash !== trustedTaskHash(task, resource, context.namespace, context.workflowId, pin.outputNameTemplates) ||
    pin.nodeBinding !== executionNodeBinding(pin.projectId, pin.id) || !pin.nodes.length || !pin.contentHash ||
    !executionPolicySchema.safeParse(pin.policy).success) throw new Error('Trusted execution profile is missing or does not match the approved task');
}
