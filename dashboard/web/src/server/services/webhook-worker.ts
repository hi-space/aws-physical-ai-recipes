import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Workflow } from '../store/types';
import { WebhookTransportError, signWebhook, parseWebhookUrl } from './webhook-http';
import {
  webhookDefaults, webhookStatuses, pendingIndex, hookKey, eventKey, deliveryKey, dueFields, parameterRef,
  type Hook, type Delivery, type WebhookEvent, type WebhookDeps, type DeliveryState,
} from './webhook-store';
import type { Write } from '../store/atomic';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = z.string().max(64).refine(v => Number.isFinite(Date.parse(v)), 'Invalid timestamp');
const payloadSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(256), status: z.enum(webhookStatuses),
  createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
}).strict();
const terminal = new Set<DeliveryState>(['DELIVERED', 'DEAD', 'CANCELLED']);

/** Parent calls after committing terminal state, from a retryable outbox path. Never sends HTTP. */
export async function enqueueWorkflowWebhook(wf: Workflow, d: WebhookDeps = webhookDefaults()): Promise<{ eventId?: string; subscribers: number }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await d.repo.getWorkflow(wf.id);
    if (!current?.projectId || !webhookStatuses.includes(current.status as typeof webhookStatuses[number])) return { subscribers: 0 };
    if (current.projectId !== wf.projectId) throw new Error('Webhook workflow project mismatch');
    const payload = payloadSchema.parse({
      runId: current.id, projectId: current.projectId, name: current.name, status: current.status,
      createdAt: current.createdAt, updatedAt: current.updatedAt, startedAt: current.startedAt, finishedAt: current.finishedAt,
    });
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 16384) throw new Error('Webhook payload limit exceeded');
    const id = `evt-${hash(JSON.stringify(['workflow.status.v1', payload.projectId, payload.runId, payload.status]))}`;
    const key = eventKey(id), existing = await d.repo.kv.get(key.pk, key.sk) as WebhookEvent | undefined;
    if (existing) return { eventId: id, subscribers: existing.subscribers };
    const hooks = (await d.repo.kv.query(`PROJECT#${payload.projectId}`, 'WEBHOOK#')).filter(item =>
      item.projectId === payload.projectId && item.state === 'ACTIVE' && item.enabled === true &&
      Number.isInteger(item.configVersion) && Number(item.configVersion) > 0 &&
      Array.isArray(item.statuses) && item.statuses.includes(payload.status)) as Hook[];
    if (hooks.length > 32) throw new Error('Webhook subscriber bound exceeded');
    const now = d.now(), createdAt = new Date(now).toISOString();
    const event: WebhookEvent = { ...key, id, projectId: payload.projectId, runId: payload.runId, status: payload.status, body, createdAt, subscribers: hooks.length };
    const writes: Write[] = [
      { kind: 'check', pk: `WF#${current.id}`, sk: 'META', condition: { equals: { projectId: payload.projectId, status: payload.status, updatedAt: current.updatedAt } } },
      { kind: 'put', item: event, condition: { absent: true } },
    ];
    for (const hook of hooks) {
      const deliveryId = `${String(now).padStart(13, '0')}-${hash(`${id}:${hook.id}`)}`;
      const delivery: Delivery = {
        ...deliveryKey(payload.projectId, hook.id, deliveryId), ...dueFields(now, deliveryId),
        id: deliveryId, projectId: payload.projectId, hookId: hook.id, eventId: id, runId: payload.runId, eventStatus: payload.status,
        configVersion: hook.configVersion, generation: hook.generation, state: 'PENDING', revision: 0,
        attempts: 0, totalAttempts: 0, redrives: 0, nextAttemptAt: now, cycleStartedAt: now,
        leaseHolder: '', leaseExpires: 0, createdAt, updatedAt: createdAt,
      };
      writes.push(
        { kind: 'check', ...hookKey(payload.projectId, hook.id), condition: { equals: { revision: hook.revision, state: 'ACTIVE', enabled: true } } },
        { kind: 'put', item: delivery, condition: { absent: true } },
      );
    }
    try {
      if (await d.repo.kv.transaction(writes)) return { eventId: id, subscribers: hooks.length };
    } catch {
      const accepted = await d.repo.kv.get(key.pk, key.sk) as WebhookEvent | undefined;
      if (accepted) return { eventId: id, subscribers: accepted.subscribers };
      throw new Error('Webhook event could not be committed; retry enqueue');
    }
  }
  throw new Error('Webhook subscriptions changed concurrently; retry enqueue');
}

async function activeHook(row: Delivery, d: WebhookDeps): Promise<Hook | undefined> {
  const key = hookKey(row.projectId, row.hookId), hook = await d.repo.kv.get(key.pk, key.sk) as Hook | undefined;
  if (!hook || hook.projectId !== row.projectId || hook.id !== row.hookId || !hook.enabled || hook.state !== 'ACTIVE' ||
      hook.configVersion !== row.configVersion || hook.generation !== row.generation || !hook.statuses.includes(row.eventStatus) ||
      hook.secretRef !== parameterRef(row.projectId, row.hookId)) return;
  if (!await d.repo.kv.get(`PROJECT#${row.projectId}`, 'META')) return;
  return hook;
}
function ended(row: Delivery, state: DeliveryState, now: number, error?: string, status?: number): Delivery {
  const { gsi1pk: _pk, gsi1sk: _sk, ...rest } = row;
  return { ...rest, state, revision: row.revision + 1, leaseHolder: '', leaseExpires: 0,
    lastError: error, lastHttpStatus: status, updatedAt: new Date(now).toISOString(),
    ...(state === 'DELIVERED' ? { deliveredAt: new Date(now).toISOString() } : {}),
  };
}
async function processDelivery(key: { pk: string; sk: string }, signal: AbortSignal, d: WebhookDeps) {
  const old = await d.repo.kv.get(key.pk, key.sk) as Delivery | undefined;
  if (!old || terminal.has(old.state) || old.nextAttemptAt > d.now() || old.leaseExpires > d.now() || signal.aborted) return;
  const maximum = d.maxAttempts ?? 8;
  if (old.attempts >= maximum || d.now() - old.cycleStartedAt > 86400_000) {
    await d.repo.kv.transaction([{ kind: 'put', item: ended(old, 'DEAD', d.now(), 'attempts_exhausted'),
      condition: { equals: { revision: old.revision, leaseExpires: old.leaseExpires } } }]);
    return;
  }
  const leaseMs = Math.max(90, d.leaseMs ?? 30000), holder = d.randomId();
  let row: Delivery = { ...old, ...dueFields(d.now() + leaseMs, old.id), state: 'SENDING', revision: old.revision + 1,
    attempts: old.attempts + 1, totalAttempts: old.totalAttempts + 1, leaseHolder: holder, leaseExpires: d.now() + leaseMs, updatedAt: new Date(d.now()).toISOString() };
  if (!await d.repo.kv.transaction([{ kind: 'put', item: row,
    condition: { equals: { revision: old.revision, leaseExpires: old.leaseExpires, state: old.state } } }])) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let renewal: Promise<void> | undefined, configChanged = false, persisting = false;
  const leaseCondition = () => ({ equals: { revision: row.revision, leaseHolder: holder, state: 'SENDING' }, after: { leaseExpires: d.now() } });
  const timer = setInterval(() => {
    if (row.leaseExpires <= d.now()) { controller.abort(); return; }
    if (renewal || controller.signal.aborted) return;
    renewal = (async () => {
      if (!await activeHook(row, d)) { configChanged = true; controller.abort(); return; }
      const next = { ...row, ...dueFields(d.now() + leaseMs, row.id), leaseExpires: d.now() + leaseMs };
      if (!await d.repo.kv.transaction([{ kind: 'put', item: next, condition: leaseCondition() }])) { controller.abort(); return; }
      row = next;
    })().catch(() => controller.abort()).finally(() => { renewal = undefined; });
  }, Math.min(5000, Math.max(20, Math.floor(leaseMs / 3))));
  timer.unref?.();
  const settle = async (state: DeliveryState, error?: string, status?: number) => {
    persisting = true;
    const next = ended(row, state, d.now(), error, status);
    if (state === 'RETRY') {
      const delay = Math.min(3600_000, 10000 * 2 ** (row.attempts - 1));
      next.nextAttemptAt = d.now() + delay + Math.floor(delay * parseInt(row.id.slice(-2), 16) / 1024);
      Object.assign(next, dueFields(next.nextAttemptAt, row.id));
    }
    await d.repo.kv.transaction([{ kind: 'put', item: next, condition: leaseCondition() }]);
  };
  try {
    const hook = await activeHook(row, d);
    if (!hook) { await settle('CANCELLED', 'configuration_changed'); return; }
    const ek = eventKey(row.eventId), event = await d.repo.kv.get(ek.pk, ek.sk) as WebhookEvent | undefined;
    if (!event || event.id !== row.eventId || event.projectId !== row.projectId || event.runId !== row.runId || event.status !== row.eventStatus) { await settle('DEAD', 'event_invalid'); return; }
    try {
      const payload = payloadSchema.parse(JSON.parse(event.body));
      if (payload.projectId !== row.projectId || payload.runId !== row.runId || payload.status !== row.eventStatus) throw new Error('Invalid event identity');
    } catch { await settle('DEAD', 'event_invalid'); return; }
    let configuration;
    try { configuration = await d.secrets.get(hook.secretRef, row.configVersion); }
    catch { throw new WebhookTransportError('configuration_unavailable'); }
    if (configuration.version !== row.configVersion || configuration.value.generation !== row.generation ||
        typeof configuration.value.secret !== 'string' || configuration.value.secret.length < 32 || configuration.value.secret.length > 256) {
      await settle('DEAD', 'configuration_invalid'); return;
    }
    parseWebhookUrl(configuration.value.endpointUrl);
    const target = await d.resolve(configuration.value.endpointUrl, controller.signal);
    controller.signal.throwIfAborted();
    if (!await activeHook(row, d)) { await settle('CANCELLED', 'configuration_changed'); return; }
    const currentLease = await d.repo.kv.get(row.pk, row.sk) as Delivery | undefined;
    if (!currentLease || currentLease.leaseHolder !== holder || currentLease.leaseExpires <= d.now() || currentLease.state !== 'SENDING') return;
    const headers = { ...signWebhook(event.id, event.body, configuration.value.secret, d.now()), 'x-pai-delivery-id': row.id };
    const status = await d.post(target, event.body, headers, controller.signal);
    if (signal.aborted || controller.signal.aborted && !configChanged) return;
    const stillActive = await activeHook(row, d);
    if (status >= 200 && status < 300) await settle('DELIVERED', stillActive ? undefined : 'configuration_changed_after_delivery', status);
    else if (!stillActive) await settle('CANCELLED', 'configuration_changed', status);
    else if (status >= 300 && status < 400) await settle('DEAD', 'http_redirect', status);
    else {
      const retry = status >= 500 || [408, 425, 429].includes(status);
      await settle(retry && row.attempts < maximum ? 'RETRY' : 'DEAD', `http_${status}`, status);
    }
  } catch (error) {
    if (persisting) return; // A lost ledger reply is not an HTTP failure; leave the claim recoverable.
    if (signal.aborted || controller.signal.aborted && !configChanged) return; // Lease expiry safely recovers ambiguous sends.
    if (configChanged) { await settle('CANCELLED', 'configuration_changed'); return; }
    const known = error instanceof WebhookTransportError;
    // Only bounded codes enter the ledger; never provider bodies, URLs, or secret values.
    await settle(known && error.permanent || row.attempts >= maximum ? 'DEAD' : 'RETRY', known ? error.code : 'delivery_failed');
  } finally {
    clearInterval(timer); signal.removeEventListener('abort', abort); controller.abort();
    await renewal;
  }
}

/** Bounded worker tick, safe to call concurrently across existing Fargate replicas. */
export async function reconcileWebhookDeliveries(signal: AbortSignal, d: WebhookDeps = webhookDefaults()): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined, processed = 0, pages = 0;
  do {
    if (signal.aborted) return;
    const page = await d.repo.kv.queryGsi1Page(pendingIndex, { limit: 50, cursor });
    cursor = page.cursor;
    const due = page.items.filter(item => Number(item.nextAttemptAt) <= d.now() && Number(item.leaseExpires) <= d.now() &&
      !seen.has(`${item.pk}/${item.sk}`)).slice(0, 20 - processed);
    for (let i = 0; i < due.length; i += 4) {
      if (signal.aborted) return;
      await Promise.all(due.slice(i, i + 4).map(async item => {
        seen.add(`${item.pk}/${item.sk}`); processed++;
        try { await processDelivery(item, signal, d); } catch { /* An uncommitted result remains recoverable after its lease expires. */ }
      }));
    }
  } while (cursor && processed < 20 && ++pages < 4);
}
