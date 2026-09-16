import { z } from 'zod';
import { resolveProject, type Project } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { parseWebhookUrl } from './webhook-http';
import {
  webhookDefaults, webhookStatuses, hookIdSchema, deliveryIdSchema, hookKey, registryKey, deliveryKey,
  parameterRef, safeHook, safeDelivery, dueFields, type Hook, type Delivery, type WebhookDeps, type WebhookSecret,
} from './webhook-store';
export type { WebhookDeps, WebhookSecret, HookMetadata } from './webhook-store';
export { enqueueWorkflowWebhook, reconcileWebhookDeliveries } from './webhook-worker';

const settings = { name: z.string().trim().min(1).max(80), statuses: z.array(z.enum(webhookStatuses)).min(1).max(3).default([...webhookStatuses]) };
const endpointUrl = z.string().min(1).max(2048);
const secret = z.string().min(32).max(256);
export const webhookInputSchema = z.object({ ...settings, endpointUrl, secret }).strict();
export const webhookRotateSchema = z.object({ endpointUrl: endpointUrl.optional(), secret }).strict();
export const webhookUpdateSchema = z.object({ name: settings.name.optional(), statuses: settings.statuses.optional(), enabled: z.boolean().optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Provide a metadata change');
const conflict = () => new HttpError(409, 'Webhook changed or configuration is in progress; refresh and retry.', 'webhook_conflict');
const configurationError = () => new HttpError(502, 'Webhook configuration could not be saved. Supply the endpoint and key again to repair it.', 'webhook_configuration');

export function webhooksService(session: Session, d: WebhookDeps = webhookDefaults()) {
  async function authorize(project: Project, write = false) {
    if (!session.subject) throw forbidden('Verified identity required');
    if (write) {
      requireRole(session, 'researcher');
      if (session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Manage webhooks through browser login');
    }
    return resolveProject(session, project.id, d.repo, write ? 'project-admin' : 'viewer');
  }
  async function read(id: string, project: Project, write = false): Promise<Hook> {
    const p = await authorize(project, write);
    if (!hookIdSchema.safeParse(id).success) throw notFound('webhook');
    const key = hookKey(p.id, id), hook = await d.repo.kv.get(key.pk, key.sk) as Hook | undefined;
    if (!hook || hook.projectId !== p.id || hook.id !== id) throw notFound('webhook');
    if (hook.secretRef !== parameterRef(p.id, id)) throw configurationError();
    return hook;
  }
  async function list(project: Project) {
    const p = await authorize(project);
    const hooks = await d.repo.kv.query(`PROJECT#${p.id}`, 'WEBHOOK#');
    await authorize(project);
    return hooks.filter(h => h.projectId === p.id).map(h => safeHook(h as Hook));
  }
  async function validated(url: string) {
    let normalized: string;
    try { normalized = parseWebhookUrl(url).href; await d.resolve(normalized, AbortSignal.timeout(5000)); }
    catch { throw badRequest('Webhook endpoint must resolve only to public HTTPS addresses.'); }
    return normalized;
  }
  async function configure(hook: Hook, value: Omit<WebhookSecret, 'generation'>, project: Project, reserved = false) {
    await authorize(project, true);
    if (!reserved && hook.state === 'UPDATING' && hook.operationUntil > d.now()) throw conflict();
    const generation = d.randomId();
    if (!/^[a-f0-9]{32}$/.test(generation)) throw configurationError();
    const bundle = { ...value, generation };
    if (Buffer.byteLength(JSON.stringify(bundle)) > 4096) throw badRequest('Webhook configuration exceeds SecureString size limit');
    const updating: Hook = { ...hook, state: 'UPDATING', generation, operationUntil: d.now() + 60000, revision: hook.revision + 1, updatedAt: new Date(d.now()).toISOString() };
    if (!await d.repo.kv.transaction([{ kind: 'put', item: updating, condition: { equals: { revision: hook.revision } } }])) throw conflict();
    try {
      let version: number;
      await authorize(project, true);
      try { version = await d.secrets.put(hook.secretRef, bundle); }
      catch {
        // A lost PutParameter reply is recoverable without retaining URL/key in DynamoDB.
        const observed = await d.secrets.get(hook.secretRef);
        if (observed.value.generation !== generation) throw configurationError();
        version = observed.version;
      }
      if (!Number.isSafeInteger(version) || version < 1) throw configurationError();
      await authorize(project, true);
      const active: Hook = { ...updating, state: updating.enabled ? 'ACTIVE' : 'DISABLED', configVersion: version, operationUntil: 0, revision: updating.revision + 1 };
      if (!await d.repo.kv.transaction([{ kind: 'put', item: active, condition: { equals: { revision: updating.revision, generation, state: 'UPDATING' } } }])) throw conflict();
      return safeHook(active);
    } catch {
      await d.repo.kv.transaction([{ kind: 'put', item: { ...updating, state: 'ERROR', operationUntil: 0, revision: updating.revision + 1 },
        condition: { equals: { revision: updating.revision, generation, state: 'UPDATING' } } }]).catch(() => false);
      throw configurationError();
    }
  }
  async function create(input: z.input<typeof webhookInputSchema>, project: Project) {
    const p = await authorize(project, true), parsed = webhookInputSchema.safeParse(input);
    if (!parsed.success) throw badRequest('Provide a name, HTTPS endpoint, signing key (32–256 characters), and terminal statuses.');
    const url = await validated(parsed.data.endpointUrl), id = `wh-${d.randomId()}`;
    if (!hookIdSchema.safeParse(id).success) throw configurationError();
    const timestamp = new Date(d.now()).toISOString();
    const hook: Hook = { ...hookKey(p.id, id), id, projectId: p.id, name: parsed.data.name,
      statuses: [...new Set(parsed.data.statuses)].sort(), state: 'UPDATING', enabled: true, revision: 0,
      secretRef: parameterRef(p.id, id), configVersion: 0, generation: '', operationUntil: d.now() + 60000,
      createdBy: session.subject!, createdAt: timestamp, updatedAt: timestamp };
    const key = registryKey(p.id);
    let reserved = false;
    for (let i = 0; i < 8 && !reserved; i++) {
      const counter = await d.repo.kv.get(key.pk, key.sk);
      if (Number(counter?.count ?? 0) >= 32) throw badRequest('At most 32 enabled webhook registrations per project; disable one first.');
      await authorize(project, true);
      reserved = await d.repo.kv.transaction([
        { kind: 'put', item: hook, condition: { absent: true } },
        { kind: 'put', item: { ...key, count: Number(counter?.count ?? 0) + 1, revision: Number(counter?.revision ?? 0) + 1 },
          condition: counter ? { equals: { revision: counter.revision } } : { absent: true } },
      ]);
    }
    if (!reserved) throw conflict();
    return configure(hook, { endpointUrl: url, secret: parsed.data.secret }, p, true);
  }
  async function rotate(id: string, input: z.input<typeof webhookRotateSchema>, project: Project) {
    const hook = await read(id, project, true), parsed = webhookRotateSchema.safeParse(input);
    if (!parsed.success) throw badRequest('Provide a new signing key and optionally a replacement HTTPS endpoint.');
    let url = parsed.data.endpointUrl;
    if (!url) {
      if (!hook.configVersion || hook.state === 'ERROR') throw badRequest('Supply the endpoint as well to repair this configuration.');
      try {
        const current = await d.secrets.get(hook.secretRef, hook.configVersion);
        if (current.version !== hook.configVersion || current.value.generation !== hook.generation) throw configurationError();
        url = current.value.endpointUrl;
      } catch { throw configurationError(); }
    }
    return configure(hook, { endpointUrl: await validated(url), secret: parsed.data.secret }, project);
  }
  async function update(id: string, input: z.input<typeof webhookUpdateSchema>, project: Project) {
    const parsed = webhookUpdateSchema.safeParse(input);
    if (!parsed.success) throw badRequest('Invalid webhook metadata change');
    const hook = await read(id, project, true), enabled = parsed.data.enabled ?? hook.enabled;
    if (hook.state === 'UPDATING' && enabled) throw conflict();
    if (enabled && hook.state === 'ERROR') throw configurationError();
    if (enabled && !hook.enabled) {
      if (!hook.configVersion) throw configurationError();
      try {
        const config = await d.secrets.get(hook.secretRef, hook.configVersion);
        if (config.value.generation !== hook.generation || config.version !== hook.configVersion) throw configurationError();
        await validated(config.value.endpointUrl);
      } catch { throw configurationError(); }
    }
    const key = registryKey(hook.projectId), counter = await d.repo.kv.get(key.pk, key.sk);
    const count = Number(counter?.count ?? 0) + Number(enabled) - Number(hook.enabled);
    if (count > 32 || count < 0) throw conflict();
    const next: Hook = { ...hook, name: parsed.data.name ?? hook.name,
      statuses: parsed.data.statuses ? [...new Set(parsed.data.statuses)].sort() : hook.statuses,
      enabled, state: enabled ? 'ACTIVE' : 'DISABLED', operationUntil: 0, revision: hook.revision + 1, updatedAt: new Date(d.now()).toISOString() };
    await authorize(project, true);
    if (!await d.repo.kv.transaction([
      { kind: 'put', item: next, condition: { equals: { revision: hook.revision } } },
      { kind: 'put', item: { ...key, count, revision: Number(counter?.revision ?? 0) + 1 }, condition: counter ? { equals: { revision: counter.revision } } : { absent: true } },
    ])) throw conflict();
    return safeHook(next);
  }
  async function deliveries(id: string, project: Project) {
    const hook = await read(id, project);
    const rows = await d.repo.kv.query(`WEBHOOK#${hook.projectId}#${id}`, 'DELIVERY#', { desc: true, limit: 50 });
    await authorize(project);
    return rows.filter(row => row.projectId === hook.projectId && row.hookId === id).map(row => safeDelivery(row as Delivery));
  }
  async function redrive(id: string, deliveryId: string, project: Project) {
    const hook = await read(id, project, true);
    if (!deliveryIdSchema.safeParse(deliveryId).success) throw notFound('delivery');
    if (!hook.enabled || hook.state !== 'ACTIVE') throw badRequest('Enable a valid configuration before redrive.');
    const key = deliveryKey(hook.projectId, id, deliveryId), row = await d.repo.kv.get(key.pk, key.sk) as Delivery | undefined;
    if (!row || row.projectId !== hook.projectId || row.hookId !== id) throw notFound('delivery');
    if (!['DEAD', 'CANCELLED'].includes(row.state)) throw conflict();
    const next: Delivery = { ...row, ...dueFields(d.now(), row.id), state: 'PENDING', attempts: 0, redrives: row.redrives + 1,
      configVersion: hook.configVersion, generation: hook.generation, nextAttemptAt: d.now(), cycleStartedAt: d.now(),
      leaseHolder: '', leaseExpires: 0, revision: row.revision + 1, updatedAt: new Date(d.now()).toISOString() };
    await authorize(project, true);
    if (!await d.repo.kv.transaction([
      { kind: 'check', ...hookKey(hook.projectId, id), condition: { equals: { revision: hook.revision, state: 'ACTIVE', enabled: true } } },
      { kind: 'put', item: next, condition: { equals: { revision: row.revision, state: row.state } } },
    ])) throw conflict();
    return safeDelivery(next);
  }
  return { list, create, rotate, update, deliveries, redrive, get: async (id: string, project: Project) => safeHook(await read(id, project)) };
}
