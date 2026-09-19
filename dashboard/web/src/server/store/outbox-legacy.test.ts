import { describe, expect, it } from 'vitest';
import { MemoryKV } from './dynamo';
import { Repo } from './repo';

describe('outbox compatibility after Step Functions removal', () => {
  it('ignores legacy dispatch/enqueue outbox items written by the previous release', async () => {
    const kv = new MemoryKV();
    const repo = new Repo(kv);
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#dispatch', kind: 'dispatch', attempts: 3, idempotencyKey: 'legacy:dispatch' });
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#enqueue', kind: 'enqueue', attempts: 0, idempotencyKey: 'legacy:enqueue' });
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#notify', kind: 'notify', attempts: 0, idempotencyKey: 'legacy:notify' });
    const entries = await repo.listOutbox('legacy');
    expect(entries.map(e => e.kind)).toEqual(['notify']);
  });

});
