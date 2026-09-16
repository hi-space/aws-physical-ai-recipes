import { expect, it } from 'vitest';
import { podInventory, type Inventory } from './kubernetes';
const pod = (uid: string, rv: string) => ({ metadata: { name: 'pod', uid, resourceVersion: rv }, spec: { containers: [] } });
it.each(['http', 'event'])('clears expired resourceVersion after %s 410 and relists before rewatching', async mode => {
  const controller = new AbortController(), paths: string[] = [];
  const responses = [
    Response.json({ metadata: { resourceVersion: '10' }, items: [pod('old', '10')] }),
    mode === 'http' ? new Response('', { status: 410 }) : new Response(JSON.stringify({ type: 'ERROR', object: { code: 410 } }) + '\n'),
    Response.json({ metadata: { resourceVersion: '20' }, items: [pod('new', '20')] }),
  ];
  const iterator = podInventory('research', 'pai.aws/workflow-id=w', controller.signal, async path => {
    paths.push(path); return responses.shift()!;
  });
  expect((await iterator.next()).value?.pods[0].metadata.uid).toBe('old');
  const reset = (await iterator.next()).value as Inventory;
  expect(reset.reset).toBe(true); expect(reset.pods.map(p => p.metadata.uid)).toEqual(['new']);
  expect(paths[1]).toContain('resourceVersion=10');
  expect(paths[2]).not.toContain('resourceVersion=');
  controller.abort(); await iterator.return(undefined);
});
