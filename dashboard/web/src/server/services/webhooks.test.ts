import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { workflowSchema } from '../workflow/schema';
import type { Project } from '../auth/projects';
import type { Workflow } from '../store/types';
import { webhooksService, enqueueWorkflowWebhook, reconcileWebhookDeliveries, type WebhookDeps, type WebhookSecret } from './webhooks';

const project: Project = { id: 'a', name: 'A', namespace: 'hyperpod-ns-a', queue: 'q-a',
  members: { admin: 'project-admin', viewer: 'viewer' }, credentialRefs: [], createdAt: 'x', updatedAt: 'x' };
const admin = { user: 'admin', subject: 'admin', role: 'researcher' as const, email: '' };
const viewer = { user: 'viewer', subject: 'viewer', role: 'viewer' as const, email: '' };
const endpointUrl = 'https://hooks.example.com/secret-path?key=private';
const secret = 'private-signing-key-'.repeat(3);
let d: WebhookDeps, now: number, seq: number, secrets: Map<string, WebhookSecret[]>;
let workflow: Workflow;
beforeEach(async () => {
  now = Date.parse('2026-09-16T12:00:00Z'); seq = 0; secrets = new Map();
  const repo = new Repo(new MemoryKV());
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project });
  workflow = { id: 'run-a', name: 'training', projectId: 'a', namespace: project.namespace, owner: 'owner',
    status: 'SUCCEEDED', spec: workflowSchema.parse({ workflow: { name: 'training', tasks: [{ name: 'run', image: 'image', command: ['true'] }] } }),
    specYaml: 'PRIVATE_YAML', vars: { SECRET: 'PRIVATE_ENV' }, createdAt: new Date(now - 10000).toISOString(),
    updatedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), taskCount: 1, succeededCount: 1, failedCount: 0 };
  await repo.putWorkflow(workflow);
  d = {
    repo, now: () => now, randomId: () => (++seq).toString(16).padStart(32, '0'),
    secrets: {
      put: vi.fn(async (ref, value) => { const versions = secrets.get(ref) ?? []; versions.push(structuredClone(value)); secrets.set(ref, versions); return versions.length; }),
      get: vi.fn(async (ref, version) => {
        const values = secrets.get(ref); const n = version ?? values?.length ?? 0;
        if (!values?.[n - 1]) throw new Error('SSM fixture unavailable');
        return { version: n, value: structuredClone(values[n - 1]) };
      }),
    },
    resolve: vi.fn<WebhookDeps['resolve']>(async () => ({ hostname: 'hooks.example.com', address: '93.184.216.34', family: 4, path: '/secret-path?key=private' })),
    post: vi.fn(async () => 204), leaseMs: 120, maxAttempts: 3,
  };
});
const create = () => webhooksService(admin, d).create({ name: 'Build events', endpointUrl, secret, statuses: ['SUCCEEDED', 'FAILED'] }, project);
const deliveries = (id: string) => webhooksService(viewer, d).deliveries(id, project);

describe('project webhook configuration', () => {
  it('stores URL and key only in SecureString, with safe metadata for viewers and mutation responses', async () => {
    const hook = await create();
    expect(hook.state).toBe('ACTIVE');
    expect([...secrets.keys()]).toEqual([`/physical-ai/projects/a/webhooks/${hook.id}`]);
    expect(JSON.stringify([...((d.repo.kv as MemoryKV).items)])).not.toContain(endpointUrl);
    expect(JSON.stringify([...((d.repo.kv as MemoryKV).items)])).not.toContain(secret);
    const listed = await webhooksService(viewer, d).list(project);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify([hook, listed])).not.toMatch(/secret-path|signing-key|physical-ai\/projects/);
  });
  it('requires current project administrator membership and rejects token management', async () => {
    await expect(webhooksService(viewer, d).create({ name: 'x', endpointUrl, secret }, project)).rejects.toMatchObject({ status: 403 });
    await expect(webhooksService({ ...admin, authMethod: 'token', tokenProjectId: 'a' }, d).create({ name: 'x', endpointUrl, secret }, project)).rejects.toMatchObject({ status: 403 });
    const hook = await create();
    await d.repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, members: {} });
    await expect(webhooksService(admin, d).rotate(hook.id, { secret }, project)).rejects.toMatchObject({ status: 403 });
  });
  it('does not leak provider errors or activate a hook after secret storage fails', async () => {
    d.secrets.put = async () => { throw new Error(endpointUrl + secret); };
    await expect(create()).rejects.not.toThrow(secret);
    const hooks = await webhooksService(viewer, d).list(project);
    expect(hooks[0].state).toBe('ERROR');
    expect(JSON.stringify(hooks)).not.toContain(endpointUrl);
    expect((await enqueueWorkflowWebhook(workflow, d)).subscribers).toBe(0);
  });
  it('adopts an accepted secret write after a lost reply using the operation generation', async () => {
    const put = d.secrets.put;
    d.secrets.put = async (ref, value) => { await put(ref, value); throw new Error('reply lost'); };
    expect((await create()).state).toBe('ACTIVE');
  });
  it('rechecks project administration after endpoint validation before changing configuration', async () => {
    const hook = await create();
    d.resolve = async () => {
      await d.repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, members: {} });
      return { hostname: 'hooks.example.com', address: '93.184.216.34', family: 4, path: '/new' };
    };
    await expect(webhooksService(admin, d).rotate(hook.id, { endpointUrl, secret: 'new-key-'.repeat(5) }, project)).rejects.toMatchObject({ status: 403 });
    expect(d.secrets.put).toHaveBeenCalledTimes(1);
    expect(await d.repo.kv.get('PROJECT#a', `WEBHOOK#${hook.id}`)).toMatchObject({ state: 'ACTIVE', revision: hook.revision });
  });
  it('bounds subscribers atomically and frees a slot when a hook is disabled', async () => {
    const hooks = [];
    for (let i = 0; i < 31; i++) hooks.push(await create());
    const last = await Promise.allSettled([create(), create()]);
    expect(last.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await webhooksService(viewer, d).list(project)).filter(h => h.enabled)).toHaveLength(32);
    await webhooksService(admin, d).update(hooks[0].id, { enabled: false }, project);
    expect((await create()).state).toBe('ACTIVE');
  });
});

describe('durable event and subscriber delivery', () => {
  it('atomically creates one immutable event and one delivery per subscriber across duplicate enqueues', async () => {
    const a = await create(), b = await create();
    const [first, second] = await Promise.all([enqueueWorkflowWebhook(workflow, d), enqueueWorkflowWebhook(workflow, d)]);
    expect(first.eventId).toBe(second.eventId);
    expect((await deliveries(a.id))).toHaveLength(1);
    expect((await deliveries(b.id))).toHaveLength(1);
    expect(d.post).not.toHaveBeenCalled();
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(a.id))[0].state).toBe('DELIVERED');
    const bodies = vi.mocked(d.post).mock.calls.map(call => JSON.parse(call[1]));
    expect(Object.keys(bodies[0]).sort()).toEqual(['createdAt', 'finishedAt', 'name', 'projectId', 'runId', 'status', 'updatedAt']);
    expect(JSON.stringify(bodies)).not.toMatch(/PRIVATE_YAML|PRIVATE_ENV|owner|spec/);
    expect(vi.mocked(d.post).mock.calls[0][2]['x-pai-event-id']).toBe(first.eventId);
  });
  it('retries with stable event IDs and changed timestamps, then dead-letters at the attempt bound', async () => {
    const hook = await create(); const event = await enqueueWorkflowWebhook(workflow, d);
    d.post = vi.fn(async () => 503);
    const signal = new AbortController().signal;
    await reconcileWebhookDeliveries(signal, d);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'RETRY', attempts: 1 });
    await reconcileWebhookDeliveries(signal, d);
    expect(d.post).toHaveBeenCalledTimes(1);
    now += 60000; await reconcileWebhookDeliveries(signal, d);
    now += 60000; await reconcileWebhookDeliveries(signal, d);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'DEAD', attempts: 3 });
    expect(vi.mocked(d.post).mock.calls.map(call => call[2]['x-pai-event-id'])).toEqual([event.eventId, event.eventId, event.eventId]);
    expect(vi.mocked(d.post).mock.calls[0][2]['x-pai-timestamp']).not.toBe(vi.mocked(d.post).mock.calls[1][2]['x-pai-timestamp']);
  });
  it('dead-letters redirects without following them and redrives only on explicit admin request', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    d.post = vi.fn(async () => 302);
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    const delivery = (await deliveries(hook.id))[0];
    expect(delivery).toMatchObject({ state: 'DEAD', lastError: 'http_redirect' });
    await expect(webhooksService(viewer, d).redrive(hook.id, delivery.id, project)).rejects.toMatchObject({ status: 403 });
    await webhooksService(admin, d).redrive(hook.id, delivery.id, project);
    d.post = vi.fn(async () => 200);
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'DELIVERED', redrives: 1 });
    expect(vi.mocked(d.post).mock.calls[0][2]['x-pai-event-id']).toBe(delivery.eventId);
  });
  it('cancels pending old-configuration deliveries on rotation or disablement', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    await webhooksService(admin, d).rotate(hook.id, { secret: 'replacement-'.repeat(4) }, project);
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0].state).toBe('CANCELLED');
    expect(d.post).not.toHaveBeenCalled();
    const delivery = (await deliveries(hook.id))[0];
    await webhooksService(admin, d).redrive(hook.id, delivery.id, project);
    await webhooksService(admin, d).update(hook.id, { enabled: false }, project);
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0].state).toBe('CANCELLED');
    expect(d.post).not.toHaveBeenCalled();
  });
  it('prevents competing workers from sending the same live leased delivery', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    let release!: () => void;
    d.post = vi.fn(() => new Promise<number>(resolve => { release = () => resolve(204); }));
    const first = reconcileWebhookDeliveries(new AbortController().signal, d);
    await vi.waitFor(() => expect(d.post).toHaveBeenCalledTimes(1));
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect(d.post).toHaveBeenCalledTimes(1);
    release(); await first;
    expect((await deliveries(hook.id))[0].state).toBe('DELIVERED');
  });
  it('recovers a lost delivery acknowledgement after lease expiry without changing event identity', async () => {
    const hook = await create(); const event = await enqueueWorkflowWebhook(workflow, d);
    const transaction = d.repo.kv.transaction.bind(d.repo.kv);
    let failAck = true;
    d.repo.kv.transaction = async writes => {
      if (failAck && writes.some(w => w.kind === 'put' && w.item.state === 'DELIVERED')) { failAck = false; throw new Error('ack lost'); }
      return transaction(writes);
    };
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0].state).toBe('SENDING');
    now += 1000;
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0].state).toBe('DELIVERED');
    expect(vi.mocked(d.post).mock.calls.map(call => call[2]['x-pai-event-id'])).toEqual([event.eventId, event.eventId]);
  });
  it('renews a slow delivery lease and prevents takeover beyond the original expiry', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    let release!: () => void;
    d.post = vi.fn(() => new Promise<number>(resolve => { release = () => resolve(204); }));
    const first = reconcileWebhookDeliveries(new AbortController().signal, d);
    await vi.waitFor(() => expect(d.post).toHaveBeenCalledTimes(1));
    const initial = [...(d.repo.kv as MemoryKV).items.values()].find(row => row.state === 'SENDING')!;
    now += 100;
    await vi.waitFor(async () => expect(Number((await d.repo.kv.get(initial.pk, initial.sk))!.leaseExpires)).toBeGreaterThan(Number(initial.leaseExpires)));
    now += 30;
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect(d.post).toHaveBeenCalledTimes(1);
    release(); await first;
    expect((await deliveries(hook.id))[0].state).toBe('DELIVERED');
  });
  it('aborts on lease loss without overwriting the new owner', async () => {
    await create(); await enqueueWorkflowWebhook(workflow, d);
    d.post = vi.fn((_target, _body, _headers, signal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const running = reconcileWebhookDeliveries(new AbortController().signal, d);
    await vi.waitFor(() => expect(d.post).toHaveBeenCalledTimes(1));
    const old = [...(d.repo.kv as MemoryKV).items.values()].find(row => row.state === 'SENDING')!;
    await d.repo.kv.put({ ...old, leaseHolder: 'new-owner', leaseExpires: now + 1000, revision: Number(old.revision) + 1 });
    await running;
    expect(await d.repo.kv.get(old.pk, old.sk)).toMatchObject({ leaseHolder: 'new-owner', state: 'SENDING' });
  });
  it('shutdown leaves an ambiguous attempt recoverable, and disablement aborts an active send', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    d.post = vi.fn((_target, _body, _headers, signal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const shutdown = new AbortController(), first = reconcileWebhookDeliveries(shutdown.signal, d);
    await vi.waitFor(() => expect(d.post).toHaveBeenCalledTimes(1));
    shutdown.abort(); await first;
    expect((await deliveries(hook.id))[0].state).toBe('SENDING');
    now += 1000;
    const second = reconcileWebhookDeliveries(new AbortController().signal, d);
    await vi.waitFor(() => expect(d.post).toHaveBeenCalledTimes(2));
    await webhooksService(admin, d).update(hook.id, { enabled: false }, project);
    await second;
    expect((await deliveries(hook.id))[0].state).toBe('CANCELLED');
  });
  it('does not transmit a stored body whose identity differs from the delivery ledger', async () => {
    const hook = await create(), event = await enqueueWorkflowWebhook(workflow, d);
    const row = (await d.repo.kv.get(`WEBHOOK_EVENT#${event.eventId}`, 'META'))!;
    await d.repo.kv.put({ ...row, body: JSON.stringify({ ...JSON.parse(String(row.body)), projectId: 'b' }) });
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'DEAD', lastError: 'event_invalid' });
    expect(d.post).not.toHaveBeenCalled();
  });
  it('retains a confirmed receiver acknowledgement when disablement races the response', async () => {
    const hook = await create(); await enqueueWorkflowWebhook(workflow, d);
    d.post = async () => {
      await webhooksService(admin, d).update(hook.id, { enabled: false }, project);
      return 204;
    };
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'DELIVERED', lastHttpStatus: 204, lastError: 'configuration_changed_after_delivery' });
  });
});
