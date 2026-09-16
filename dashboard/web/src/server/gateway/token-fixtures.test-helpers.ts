import { createHash } from 'node:crypto';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { createApiToken, revokeApiToken, verifyApiToken, type ApiTokenDeps } from '../auth/api-tokens';
import type { Project } from '../auth/projects';
import type { CurrentUserAuthorization } from '../aws/cognito';
import type { AuthOptions, GatewaySession } from './types';

export async function tokenFixture() {
  const repo = new Repo(new MemoryKV());
  const browser = { subject: 'subject-a', user: 'alice', email: 'alice@example.invalid', role: 'researcher' as const };
  const project: Project = { id: 'team-a', name: 'A', namespace: 'hyperpod-ns-team-a', queue: 'team-a-localqueue', members: { 'subject-a': 'researcher' }, credentialRefs: [], createdAt: '', updatedAt: '' };
  await repo.kv.put({ pk: 'PROJECT#team-a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: project.id, ...project });
  const state = { now: Date.now(), failUser: false, user: { username: 'alice', subject: 'subject-a', email: '', enabled: true, groups: ['researchers'] } as CurrentUserAuthorization };
  const currentUser = async () => { if (state.failUser) throw new Error('synthetic provider error'); return structuredClone(state.user); };
  const tokenDeps: ApiTokenDeps = { kv: repo.kv, now: () => state.now, currentUser, randomId: () => 'a'.repeat(32), randomToken: () => `pai_${Buffer.alloc(32, 7).toString('base64url')}` };
  const issued = await createApiToken(browser, project, { name: 'test', scopes: ['sessions:read', 'sessions:write'], expiresInDays: 1 }, tokenDeps);
  const principal = await verifyApiToken(issued.token, 'POST', '/api/sessions', tokenDeps);
  const options: AuthOptions = { repo, now: () => state.now, currentUser };
  const session: GatewaySession = { id: 'derived', kind: 'port-forward', namespace: project.namespace, projectId: project.id, ownerSubject: browser.subject,
    expiresAt: new Date(state.now + 60_000).toISOString(), podName: 'owned-pod', container: 'main', port: 8077,
    authMethod: 'token', tokenId: principal.tokenId, tokenProjectId: project.id, tokenRole: 'researcher', tokenExpiresAt: issued.metadata.expiresAt };
  await repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...session });
  const ownerKey = { pk: `PROJECT#${project.id}`, sk: `TOKEN#${createHash('sha256').update(browser.subject).digest('hex')}#${principal.tokenId}` };
  const digestKey = { pk: `API_TOKEN#${createHash('sha256').update(issued.token).digest('hex')}`, sk: 'META' };
  async function changeToken(change: Record<string, unknown>, which: 'both' | 'owner' | 'digest' = 'both') {
    for (const key of which === 'both' ? [ownerKey, digestKey] : [which === 'owner' ? ownerKey : digestKey]) {
      await repo.kv.put({ ...(await repo.kv.get(key.pk, key.sk))!, ...change });
    }
  }
  return { repo, browser, principal, project, state, options, session, issued, ownerKey, digestKey, changeToken,
    revoke: () => revokeApiToken(browser, project, principal.tokenId, tokenDeps) };
}
