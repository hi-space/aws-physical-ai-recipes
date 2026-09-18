import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { issueLaunchTicket, consumeTicket } from './auth';
import { createGatewayServer } from './server';
import type { GatewaySession, TerminalCallbacks } from './types';

const host = 'shell.apps.physical-ai.hi-yoo.com';
const servers: ReturnType<typeof createGatewayServer>[] = [];
const browsers: WebSocket[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) browser.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function terminal() {
  const repo = new Repo(new MemoryKV());
  const session: GatewaySession = { id: 'shell', kind: 'terminal', namespace: 'research', podName: 'owned-pod',
    container: 'main', ownerSubject: 'sub', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await repo.kv.put({ pk: 'SESS#shell', sk: 'META', ...session });
  const inputs: string[] = [], sizes: number[][] = [];
  let callbacks: TerminalCallbacks;
  let closed = false;
  let target: GatewaySession | undefined;
  const server = createGatewayServer({ repo, dashboardOrigin: 'https://physical-ai.hi-yoo.com', recheckMs: 20, transport: {
    connect: async () => { throw new Error('terminal must not use port-forward'); },
    exec: async (s, cb) => {
      callbacks = cb; target = s;
      return { input: (data) => { inputs.push(data); cb.stdout(data); }, resize: (cols, rows) => sizes.push([cols, rows]), close: () => { closed = true; } };
    },
  } });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const launch = await issueLaunchTicket(session, { subject: 'sub' }, { repo });
  const cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/__gateway/terminal`,
    { headers: { host, cookie, origin: `https://${host}` } });
  browsers.push(ws); await once(ws, 'open');
  return { ws, repo, inputs, sizes, callbacks: () => callbacks, closed: () => closed, target: () => target };
}

describe('browser terminal websocket protocol', () => {
  it('accepts input/resize, sends JSON stdout/stderr and closes exec on browser disconnect', async () => {
    const t = await terminal();
    const message = once(t.ws, 'message');
    t.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 42 }));
    t.ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
    expect(JSON.parse((await message)[0].toString())).toEqual({ type: 'stdout', data: 'pwd\n' });
    expect(t.inputs).toEqual(['pwd\n']); expect(t.sizes).toEqual([[120, 42]]);
    expect(t.target()).toMatchObject({ podName: 'owned-pod', container: 'main', namespace: 'research' });
    const errorOutput = once(t.ws, 'message'); t.callbacks().stderr('stderr output');
    expect(JSON.parse((await errorOutput)[0].toString())).toEqual({ type: 'stderr', data: 'stderr output' });
    t.ws.close(); await once(t.ws, 'close');
    expect(t.closed()).toBe(true);
  });
  it('delivers the exit status and normal close handshake', async () => {
    const t = await terminal();
    const message = once(t.ws, 'message'), close = once(t.ws, 'close');
    t.callbacks().exit(7);
    expect(JSON.parse((await message)[0].toString())).toEqual({ type: 'exit', code: 7 });
    expect((await close)[0]).toBe(1000);
  });
  it.each([
    { type: 'input', data: 'id', podName: 'other-pod' },
    { type: 'resize', cols: 0, rows: 24 },
    { type: 'resize', cols: 80, rows: 1001 },
    { type: 'exec', command: 'sh' },
  ])('rejects unsupported terminal messages and ends exec', async (message) => {
    const t = await terminal();
    const closed = once(t.ws, 'close');
    t.ws.send(JSON.stringify(message));
    await closed;
    expect(t.closed()).toBe(true);
    expect(t.inputs).toEqual([]); expect(t.sizes).toEqual([]);
  });
  it('closes exec when its persisted session is revoked', async () => {
    const t = await terminal();
    const closed = once(t.ws, 'close');
    await t.repo.deleteSession('shell');
    await closed;
    expect(t.closed()).toBe(true);
  });
});
