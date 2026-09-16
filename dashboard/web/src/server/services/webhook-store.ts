import { randomBytes } from 'node:crypto';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import { ssm } from '../aws/clients';
import { resolveWebhookTarget, postWebhook, type WebhookTarget } from './webhook-http';

export const webhookStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type WebhookStatus = typeof webhookStatuses[number];
export const hookIdSchema = z.string().regex(/^wh-[a-f0-9]{32}$/);
export const deliveryIdSchema = z.string().regex(/^\d{13}-[a-f0-9]{64}$/);
export interface WebhookSecret { endpointUrl: string; secret: string; generation: string }
export interface WebhookDeps {
  repo: Repo; now(): number; randomId(): string;
  secrets: { put(ref: string, value: WebhookSecret): Promise<number>; get(ref: string, version?: number): Promise<{ version: number; value: WebhookSecret }> };
  resolve(url: string, signal: AbortSignal): Promise<WebhookTarget>;
  post(target: WebhookTarget, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<number>;
  leaseMs?: number; maxAttempts?: number;
}
export interface Hook extends Item {
  id: string; projectId: string; name: string; statuses: WebhookStatus[]; enabled: boolean;
  state: 'UPDATING' | 'ACTIVE' | 'DISABLED' | 'ERROR'; revision: number;
  secretRef: string; configVersion: number; generation: string; operationUntil: number;
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface HookMetadata {
  id: string; projectId: string; name: string; statuses: WebhookStatus[]; enabled: boolean;
  state: Hook['state']; revision: number; createdBy: string; createdAt: string; updatedAt: string;
}
export interface WebhookEvent extends Item {
  id: string; projectId: string; runId: string; status: WebhookStatus; body: string; createdAt: string; subscribers: number;
}
export type DeliveryState = 'PENDING' | 'SENDING' | 'RETRY' | 'DELIVERED' | 'DEAD' | 'CANCELLED';
export interface Delivery extends Item {
  id: string; hookId: string; projectId: string; eventId: string; runId: string; eventStatus: WebhookStatus;
  configVersion: number; generation: string; state: DeliveryState; revision: number;
  attempts: number; totalAttempts: number; redrives: number; nextAttemptAt: number; cycleStartedAt: number;
  leaseHolder: string; leaseExpires: number; createdAt: string; updatedAt: string;
  lastError?: string; lastHttpStatus?: number; deliveredAt?: string;
}
export const pendingIndex = 'TYPE#WEBHOOK_DELIVERY_PENDING';
export const hookKey = (project: string, id: string) => ({ pk: `PROJECT#${project}`, sk: `WEBHOOK#${id}` });
export const registryKey = (project: string) => ({ pk: `PROJECT#${project}`, sk: 'WEBHOOK_REGISTRY' });
export const eventKey = (id: string) => ({ pk: `WEBHOOK_EVENT#${id}`, sk: 'META' });
export const deliveryKey = (project: string, hook: string, id: string) => ({ pk: `WEBHOOK#${project}#${hook}`, sk: `DELIVERY#${id}` });
export function parameterRef(project: string, id: string) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(project) || !hookIdSchema.safeParse(id).success) throw new Error('Invalid webhook identity');
  return `/physical-ai/projects/${project}/webhooks/${id}`;
}
export const dueFields = (at: number, id: string) => ({ gsi1pk: pendingIndex, gsi1sk: `${String(at).padStart(16, '0')}#${id}` });
export function safeHook(h: Hook): HookMetadata {
  return { id: h.id, projectId: h.projectId, name: h.name, statuses: [...h.statuses], enabled: h.enabled, state: h.state,
    revision: h.revision, createdBy: h.createdBy, createdAt: h.createdAt, updatedAt: h.updatedAt };
}
export function safeDelivery(d: Delivery) {
  return { id: d.id, eventId: d.eventId, runId: d.runId, eventStatus: d.eventStatus, state: d.state, attempts: d.attempts,
    totalAttempts: d.totalAttempts, redrives: d.redrives, nextAttemptAt: ['PENDING', 'RETRY'].includes(d.state) ? d.nextAttemptAt : undefined,
    createdAt: d.createdAt, updatedAt: d.updatedAt, deliveredAt: d.deliveredAt, lastError: d.lastError, lastHttpStatus: d.lastHttpStatus };
}
export function webhookDefaults(): WebhookDeps {
  return { repo: getRepo(), now: Date.now, randomId: () => randomBytes(16).toString('hex'),
    resolve: resolveWebhookTarget, post: postWebhook,
    secrets: {
      put: async (ref, value) => {
        const result = await ssm().send(new PutParameterCommand({ Name: ref, Value: JSON.stringify(value), Type: 'SecureString', Tier: 'Standard', Overwrite: true }),
          { abortSignal: AbortSignal.timeout(10000) });
        if (!result.Version) throw new Error('Webhook configuration unavailable');
        return result.Version;
      },
      get: async (ref, version) => {
        const result = await ssm().send(new GetParameterCommand({ Name: version ? `${ref}:${version}` : ref, WithDecryption: true }),
          { abortSignal: AbortSignal.timeout(10000) });
        const value = JSON.parse(result.Parameter?.Value ?? '');
        if (!result.Parameter?.Version || typeof value.endpointUrl !== 'string' || typeof value.secret !== 'string' || typeof value.generation !== 'string') throw new Error('Webhook configuration unavailable');
        return { version: result.Parameter.Version, value };
      },
    },
  };
}
