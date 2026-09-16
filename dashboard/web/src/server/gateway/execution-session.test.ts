import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { issueLaunchTicket, consumeTicket, authorizeCookie } from './auth';
import type { AuthOptions, GatewaySession } from './types';
import { guardConnection } from './lifetime';

let repo: Repo, s: GatewaySession, options: AuthOptions, pod: any, user: any;
const principal = { subject: 'alice-sub', user: 'alice', role: 'admin' as const, authMethod: 'alb' as const };
const host = 'trusted.apps.physical-ai.hi-yoo.com';
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  s = { id: 'trusted', kind: 'terminal', ownerSubject: principal.subject, authMethod: 'alb', trustedExecution: true,
    namespace: 'research', projectId: 'p', workflowId: 'w', taskName: 'train', attempt: 2, attemptEpoch: 'epoch2',
    replicaIndex: 0, podName: 'train-pod', podUid: 'uid1', nodeName: 'node1', container: 'main', expiresAt: '2026-09-16T13:00:00Z' };
  pod = { metadata: { name: s.podName, uid: s.podUid, labels: { 'pai.aws/workflow-id': 'w', 'pai.aws/task': 'train', 'pai.aws/attempt': '2', 'pai.aws/epoch': 'epoch2', 'batch.kubernetes.io/job-completion-index': '0' } },
    spec: { nodeName: 'node1', containers: [{ name: 'main' }] }, status: { phase: 'Running' } };
  user = { enabled: true, subject: principal.subject, groups: ['admins'] };
  options = { repo, now: () => Date.parse('2026-09-16T12:00:00Z'), currentUser: async () => user,
    validateExecutionProfile: vi.fn(async () => {}), getPod: async () => pod };
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'research', members: { 'alice-sub': 'project-admin' } });
  await repo.kv.put({ pk: 'WF#w', sk: 'META', id: 'w', namespace: 'research', projectId: 'p', owner: 'alice', ownerSubject: 'alice-sub',
    status: 'RUNNING', spec: { workflow: { tasks: [{ name: 'train', executionProfile: { id: 'trusted', version: 1 } }] } },
    executionProfilePins: { train: { nodes: [{ name: 'node1', uid: 'node-uid' }], policy: { hostNetwork: false } } } });
  await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 2, attemptEpoch: 'epoch2' });
  await repo.kv.put({ pk: 'WF#w', sk: 'RUNTIME#epoch2#META', released: true });
  await member({ phase: 'RUNNING', processStarted: true, readyEver: true });
  await save();
});
const save = () => repo.kv.put({ pk: 'SESS#trusted', sk: 'META', ...s });
const member = (values: object) => repo.kv.put({ pk: 'WF#w', sk: 'RUNTIME#epoch2#MEMBER#train#0', ...values });
const launch = () => issueLaunchTicket(s, principal, options);
it('permits an accepted current process with fresh browser-admin and profile approval', async () => {
  const ticket = await launch();
  const { cookie } = await consumeTicket(ticket.ticket, host, options);
  expect((await authorizeCookie(cookie.split(';')[0], host, options)).podUid).toBe('uid1');
});
it.each([
  { phase: 'INITIALIZING', readyEver: true, processStarted: false },
  { phase: 'RUNNING', readyEver: true, processStarted: false },
  { phase: 'SUCCEEDED', readyEver: true, processStarted: true },
])('rejects a Running Pod whose process has not been accepted: %j', async value => {
  await member(value);
  await expect(launch()).rejects.toMatchObject({ status: 403 });
});
it.each(['disabled', 'subject', 'groups'])('requires current Cognito %s at issuance, redemption and lifetime checks', async change => {
  const first = await launch(), second = await launch();
  const { cookie } = await consumeTicket(first.ticket, host, options);
  if (change === 'disabled') user.enabled = false;
  if (change === 'subject') user.subject = 'replacement';
  if (change === 'groups') user.groups = ['researcher'];
  await expect(launch()).rejects.toMatchObject({ status: 403 });
  await expect(consumeTicket(second.ticket, host, options)).rejects.toMatchObject({ status: 403 });
  await expect(authorizeCookie(cookie.split(';')[0], host, options)).rejects.toMatchObject({ status: 403 });
});
it('rejects token-created sessions and token callers even if Cognito currently reports admin', async () => {
  await expect(issueLaunchTicket(s, { ...principal, authMethod: 'token', tokenId: 't', tokenProjectId: 'p' }, options)).rejects.toBeDefined();
  s.authMethod = 'token'; s.tokenId = 't'; await save();
  await expect(launch()).rejects.toBeDefined();
});
it.each(['profile', 'barrier', 'attempt', 'pod', 'member', 'node', 'fence'])('invalidates outstanding tickets and active grants after %s changes', async change => {
  const first = await launch(), second = await launch();
  const { cookie } = await consumeTicket(first.ticket, host, options);
  if (change === 'profile') options.validateExecutionProfile = async () => { throw Object.assign(new Error('revoked'), { status: 409 }); };
  if (change === 'barrier') await repo.kv.put({ pk: 'WF#w', sk: 'RUNTIME#epoch2#META', released: false });
  if (change === 'attempt') await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 3, attemptEpoch: 'epoch3' });
  if (change === 'pod') pod.metadata.uid = 'replacement';
  if (change === 'member') pod.metadata.labels['batch.kubernetes.io/job-completion-index'] = '1';
  if (change === 'node') pod.spec.nodeName = 'node2';
  if (change === 'fence') await repo.kv.put({ pk: 'WF#w', sk: 'FENCE#epoch2' });
  await expect(consumeTicket(second.ticket, host, options)).rejects.toBeDefined();
  await expect(authorizeCookie(cookie.split(';')[0], host, options)).rejects.toBeDefined();
});
it('allows host-network terminal exec but rejects its HTTP grant', async () => {
  pod.spec.hostNetwork = true; s.hostNetwork = true; await save();
  await expect(launch()).resolves.toHaveProperty('url');
  s.kind = 'port-forward'; s.port = 8077; await save();
  await expect(launch()).rejects.toBeDefined();
});
it('aborts an active connection when current browser-administrator membership is revoked', async () => {
  const ticket = await launch(), { cookie } = await consumeTicket(ticket.ticket, host, options);
  const connection = new AbortController();
  const cleanup = guardConnection(s, cookie.split(';')[0], host, connection, { ...options, recheckMs: 10 });
  try {
    user.groups = [];
    await vi.waitFor(() => expect(connection.signal.aborted).toBe(true), { timeout: 1000 });
  } finally { cleanup(); }
});
