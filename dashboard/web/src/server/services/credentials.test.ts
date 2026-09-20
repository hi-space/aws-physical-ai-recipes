import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import type { Project } from '../auth/projects';
import { projectItem } from '../auth/projects';
import type { Session } from '../auth/session';
import { projectFixture, testSession } from '../auth/session.test-helpers';
import { assertCredentialUse, createCredential, deleteCredential, listCredentials, registerLegacyCredential, rotateCredential, type CredentialDeps } from './credentials';

const alice: Session = testSession('alice', 'sub-a', 'researcher', ['proj-team-a']);
const bob: Session = testSession('bob', 'sub-b', 'researcher', ['proj-team-a-admin']);
const admin: Session = testSession('admin', 'sub-admin', 'admin');
const project: Project = projectFixture('team-a');
let kv: MemoryKV, deps: CredentialDeps;
beforeEach(async () => {
  kv = new MemoryKV(); let id = 0;
  await kv.put(projectItem(project));
  deps = { kv, now: () => 1_800_000_000_000, randomId: () => (++id).toString(16).padStart(32, '0'), parameters: { put: vi.fn(async () => 1), delete: vi.fn(async () => {}) } };
});

describe('project credential ownership and secret storage', () => {
  it('stores only metadata, puts a SecureString reference under a hashed subject, and never returns the value', async () => {
    const metadata = await createCredential(alice, project, { name: 'HF', kind: 'hf', value: 'private-token-value' }, deps);
    expect(metadata.ref).toMatch(/^\/physical-ai\/projects\/team-a\/users\/[a-f0-9]{64}\/[a-f0-9]{32}$/);
    expect(metadata.status).toBe('READY');
    expect(deps.parameters.put).toHaveBeenCalledWith(metadata.ref, 'private-token-value', false);
    expect(JSON.stringify([...kv.items.values()])).not.toContain('private-token-value');
    expect(JSON.stringify(await listCredentials(alice, project, deps))).not.toContain('private-token-value');
    expect(metadata).not.toHaveProperty('value');
    await expect(assertCredentialUse(alice, project, metadata.ref, deps)).resolves.toBeUndefined();
  });
  it('does not expose or permit private credentials to teammates or another platform admin', async () => {
    const own = await createCredential(alice, project, { name: 'HF', kind: 'hf', value: 'secret' }, deps);
    for (const other of [bob, admin]) {
      expect(await listCredentials(other, project, deps)).toEqual([]);
      await expect(assertCredentialUse(other, project, own.ref, deps)).rejects.toMatchObject({ status: 403 });
      await expect(rotateCredential(other, project, own.id, 'new', deps)).rejects.toMatchObject({ status: 403 });
      await expect(deleteCredential(other, project, own.id, deps)).rejects.toMatchObject({ status: 403 });
    }
  });
  it('requires project admin for explicit sharing and checks fresh membership', async () => {
    await expect(createCredential(alice, project, { name: 'NGC', kind: 'ngc', scope: 'project', value: 'secret' }, deps)).rejects.toMatchObject({ status: 403 });
    const shared = await createCredential(bob, project, { name: 'NGC', kind: 'ngc', scope: 'project', value: 'secret' }, deps);
    expect(shared.ref).toContain('/shared/');
    await expect(assertCredentialUse(alice, project, shared.ref, deps)).resolves.toBeUndefined();
    // Member group removed entirely ⇒ no project membership at all.
    const aliceRemoved: Session = testSession('alice', 'sub-a', 'researcher');
    await expect(assertCredentialUse(aliceRemoved, project, shared.ref, deps)).rejects.toMatchObject({ status: 403 });
  });
  it('rotates only through an exclusive lifecycle state and leaves no old secret in metadata', async () => {
    const own = await createCredential(alice, project, { name: 'HF', kind: 'hf', value: 'old-value' }, deps);
    let release!: (version: number) => void;
    deps.parameters.put = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const pending = rotateCredential(alice, project, own.id, 'new-value', deps);
    await vi.waitFor(() => expect(deps.parameters.put).toHaveBeenCalled());
    await expect(assertCredentialUse(alice, project, own.ref, deps)).rejects.toMatchObject({ status: 409 });
    await expect(deleteCredential(alice, project, own.id, deps)).rejects.toMatchObject({ status: 409 });
    release(2);
    expect(await pending).toMatchObject({ status: 'READY', parameterVersion: 2 });
    expect(JSON.stringify([...kv.items.values()])).not.toMatch(/old-value|new-value/);
  });
  it('fails closed after SSM write failure and does not leak the SSM error body', async () => {
    deps.parameters.put = vi.fn(async () => { throw new Error('raw-secret echoed by provider'); });
    await expect(createCredential(alice, project, { name: 'HF', kind: 'hf', value: 'raw-secret' }, deps)).rejects.not.toThrow('raw-secret');
    const [metadata] = await listCredentials(alice, project, deps);
    expect(metadata.status).toBe('ERROR');
    expect(JSON.stringify([...kv.items.values()])).not.toContain('raw-secret');
    await expect(assertCredentialUse(alice, project, metadata.ref, deps)).rejects.toMatchObject({ status: 409 });
  });
  it('registers a legacy reference without reading or deleting its SSM parameter', async () => {
    const legacy = await registerLegacyCredential(admin, project, { name: 'workshop', kind: 'hf', scope: 'project', ref: '/groot/hf-token' }, deps);
    expect(legacy).toMatchObject({ managed: false, status: 'REGISTERED' });
    expect(deps.parameters.put).not.toHaveBeenCalled();
    await assertCredentialUse(alice, project, legacy.ref, deps);
    await deleteCredential(admin, project, legacy.id, deps);
    expect(deps.parameters.delete).not.toHaveBeenCalled();
    await expect(assertCredentialUse(alice, project, legacy.ref, deps)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects unregistered legacy refs and private-path aliases even for admin', async () => {
    await expect(assertCredentialUse(admin, { ...project, credentialRefs: ['/groot/hf-token'] }, '/groot/hf-token', deps)).rejects.toMatchObject({ status: 403 });
    await expect(registerLegacyCredential(admin, project, { name: 'alias', kind: 'generic', scope: 'project', ref: '/physical-ai/projects/other/users/private/key' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(registerLegacyCredential(alice, project, { name: 'legacy', kind: 'hf', ref: '/groot/hf-token' }, deps)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects token management, cross-project use, unsafe references and oversize values', async () => {
    await expect(createCredential({ ...alice, authMethod: 'token' }, project, { name: 'HF', kind: 'hf', value: 'secret' }, deps)).rejects.toMatchObject({ status: 403 });
    await expect(createCredential(alice, project, { name: 'HF', kind: 'hf', value: '한'.repeat(2000) }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(assertCredentialUse({ ...alice, tokenProjectId: 'other' }, project, '/groot/hf-token', deps)).rejects.toMatchObject({ status: 403 });
    await expect(registerLegacyCredential(admin, project, { name: 'bad', kind: 'generic', ref: '/groot/../key' }, deps)).rejects.toMatchObject({ status: 400 });
  });
});
