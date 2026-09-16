import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { Workflow } from '../store/types';
import type { TaskSpec } from '../workflow/schema';
import { durationToSeconds } from '../workflow/schema';
import { backendId } from '../backends/registry';
export const capabilitySchema = z.object({
  v: z.literal(1),
  aud: z.enum(['pai-runtime', 'pai-mlflow']),
  workflowId: z.string().min(1).max(128),
  task: z.string().min(1).max(40),
  groupId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(63),
  namespace: z.string().min(1).max(63),
  backendId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default('default'),
  epoch: z.string().min(1).max(128),
  attempt: z.number().int().positive(),
  iat: z.number().int(),
  exp: z.number().int()
}).strict();
export type CapabilityAudience = 'pai-runtime' | 'pai-mlflow';
export type Capability = z.infer<typeof capabilitySchema>;
export const gone = () => new HttpError(410, 'Runtime capability is expired, cancelled, or fenced', 'runtime_fenced');
export function groupFor(wf: Workflow, task: string) {
  return wf.spec.workflow.groups?.find(group => group.tasks.some(member => member.name === task));
}
function secret(key: string) {
  if (Buffer.byteLength(key) < 32) throw new HttpError(503, 'Runtime signing key is not configured', 'runtime_unavailable');
  return key;
}
export function mintCapability(wf: Workflow, task: TaskSpec, epoch: string, attempt: number, key: string, now: Date, audience: CapabilityAudience = 'pai-runtime'): string {
  const member = wf.spec.workflow.tasks.find(t => t.name === task.name);
  if (!member) throw new HttpError(400, 'Task is not a workflow member');
  const group = groupFor(wf, task.name),
    timeout = group?.timeout ?? wf.spec.workflow.timeout;
  const ttl = Math.min(8 * 86400, durationToSeconds(timeout.queue_timeout) + durationToSeconds(timeout.start_timeout) + durationToSeconds(timeout.exec_timeout) + 3600);
  const iat = Math.floor(now.getTime() / 1000);
  const claim = capabilitySchema.parse({
    v: 1,
    aud: audience,
    workflowId: wf.id,
    task: task.name,
    groupId: group?.name ?? `task:${task.name}`,
    projectId: wf.projectId ?? 'legacy',
    namespace: wf.namespace,
    backendId: backendId(wf.backendId),
    epoch,
    attempt,
    iat,
    exp: iat + ttl
  });
  const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `v1.${body}.${createHmac('sha256', secret(key)).update(`v1.${body}`).digest('base64url')}`;
}
export function verifyCapability(token: string, key: string, now: Date, audience: CapabilityAudience = 'pai-runtime'): Capability {
  secret(key);
  const invalid = () => new HttpError(401, 'Invalid runtime capability', 'invalid_runtime_capability');
  if (token.length > 8192 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  const [version, body, signature] = token.split('.');
  const expected = createHmac('sha256', key).update(`${version}.${body}`).digest(),
    actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || actual.toString('base64url') !== signature || !timingSafeEqual(expected, actual)) throw invalid();
  let claim: Capability;
  try {
    claim = capabilitySchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    throw invalid();
  }
  if (claim.aud !== audience) throw invalid();
  const seconds = Math.floor(now.getTime() / 1000);
  if (claim.exp <= seconds) throw gone();
  if (claim.iat > seconds + 30 || claim.exp <= claim.iat || claim.exp - claim.iat > 8 * 86400) throw invalid();
  return claim;
}
