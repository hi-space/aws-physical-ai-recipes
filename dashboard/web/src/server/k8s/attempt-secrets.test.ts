import { expect, it, vi } from 'vitest';
import { ensureAttemptSecret, type AttemptSecret, type AttemptSecretPort } from './attempt-secrets';
import { managedLabels } from './resources';
const labels = { 'pai.aws/workflow-id': 'run', 'pai.aws/task': 'train', 'pai.aws/attempt': '1', 'pai.aws/epoch': 'epoch', 'pai.aws/project': 'p' };
function fixture() {
  let stored: AttemptSecret | null = null;
  const port: AttemptSecretPort = { get: vi.fn(async () => stored), create: vi.fn(async (_namespace, value) => {
    const source = value as AttemptSecret;
    stored = { ...source, metadata: { ...source.metadata, uid: 'original-secret' } };
    return stored;
  }) };
  return { port, get: () => stored!, set: (value: AttemptSecret) => { stored = value; } };
}
it('pins immutable original values through reconciliation and SSM rotation', async () => {
  const f = fixture();
  expect(await ensureAttemptSecret('team', 'run-creds', { TOKEN: 'original' }, labels, f.port)).toEqual({ uid: 'original-secret' });
  expect(f.get().immutable).toBe(true);
  expect(await ensureAttemptSecret('team', 'run-creds', { TOKEN: 'rotated' }, labels, f.port)).toEqual({ uid: 'original-secret' });
  expect(Buffer.from(f.get().data!.TOKEN, 'base64').toString()).toBe('original');
  expect(f.port.create).toHaveBeenCalledTimes(1);
});
it('adopts an ambiguous committed CREATE but never mutable, foreign or key-substituted records', async () => {
  const f = fixture(), original = f.port.create;
  f.port.create = async (...args) => { await original(...args); throw new Error('lost response'); };
  expect(await ensureAttemptSecret('team', 'run-creds', { TOKEN: 'original' }, labels, f.port)).toEqual({ uid: 'original-secret' });
  const saved = f.get();
  for (const invalid of [
    { ...saved, immutable: false },
    { ...saved, data: { OTHER: 'eA==' } },
    { ...saved, metadata: { ...saved.metadata, labels: managedLabels({ ...labels, 'pai.aws/epoch': 'other' }) } },
  ]) {
    f.set(invalid);
    await expect(ensureAttemptSecret('team', 'run-creds', { TOKEN: 'original' }, labels, f.port)).rejects.toThrow('Attempt Secret');
  }
});
