import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as httpsServer, type Server as HttpsServer } from 'node:https';
import { request, type IncomingHttpHeaders, type ClientRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGatewayServer, type GatewayOptions } from './server';
import { issueLaunchTicket, consumeTicket } from './auth';
import { resolveRoute } from './routing';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { DcvUpstream, GatewaySession } from './types';

let fixture: string, ca: Buffer, key: Buffer;
let upstream: HttpsServer | undefined, gateway: ReturnType<typeof createGatewayServer> | undefined;
const pending: Array<() => void> = [];
const host = 'connect.apps.physical-ai.hi-yoo.com';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'pai-connect-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  ca = readFileSync(join(fixture, 'cert.pem')); key = readFileSync(join(fixture, 'key.pem'));
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
afterEach(async () => {
  if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
  for (const resume of pending.splice(0)) resume();
  await new Promise(resolve => setImmediate(resolve));
  if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()));
  gateway = undefined; upstream = undefined;
  vi.restoreAllMocks();
});
async function within<T>(promise: Promise<T>, milliseconds = 1200): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No bounded gateway response')), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}
async function setup(options: GatewayOptions = {}, behavior: 'immediate' | 'slow' | 'held' = 'immediate', kind: 'dcv' | 'port-forward' = 'dcv') {
  const repo = new Repo(new MemoryKV()); let closed = 0, requests = 0, signal: AbortSignal | undefined;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; }); pending.push(release);
  const session: GatewaySession = { id: 'connect', kind, ownerSubject: 'owner', namespace: 'research',
    nodeName: 'node', ssmTarget: 'registered', dcvSessionId: 'dcv-owned', podName: 'pod', container: 'main', port: 8080,
    expiresAt: new Date(Date.now() + 180_000).toISOString() };
  await repo.kv.put({ pk: 'SESS#connect', sk: 'META', ...session });
  upstream = httpsServer({ key, cert: ca }, (_req, res) => { requests++; res.end('connected'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const target = (): DcvUpstream => ({ url: new URL(`https://127.0.0.1:${(upstream!.address() as AddressInfo).port}`), ca, servername: 'localhost', close: () => { closed++; } });
  gateway = createGatewayServer({ repo, dashboardOrigin: 'https://physical-ai.hi-yoo.com', ...options, getDcvUpstream: async (_session, context) => {
    signal = context.signal; entered();
    if (behavior === 'slow') await sleep(90);
    if (behavior === 'held') await held; // Deliberately ignores abort to verify late-acquisition cleanup.
    return target();
  }, transport: {
    connect: async (_session, abortSignal) => { signal = abortSignal; entered(); await held; throw new Error('synthetic connector stopped'); },
    exec: async () => { throw new Error('not used'); },
  } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const launch = await issueLaunchTicket(session, { subject: 'owner' }, { repo });
  const cookie = (await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, { repo }), { repo })).cookie.split(';')[0];
  function start(upgrade = false) {
    let req!: ClientRequest;
    const result = new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; complete: boolean }>((resolve, reject) => {
      req = request({ host: '127.0.0.1', port: (gateway!.address() as AddressInfo).port, headers: { host, cookie,
        ...(upgrade ? { origin: `https://${host}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64') } : {}) } }, res => {
        let body = ''; res.on('data', b => { body += b; }); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body, complete: res.complete }));
      });
      req.on('error', reject); req.end();
    });
    void result.catch(() => undefined);
    return { req, result };
  }
  return { start, started, release, signal: () => signal, closed: () => closed, requests: () => requests };
}

describe('gateway upstream connection budgets', () => {
  it('allocates a 60-second DCV connect budget by default', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const f = await setup();
    expect((await f.start().result).status).toBe(200);
    expect(timer.mock.calls.some(([, delay]) => delay === 60_000)).toBe(true);
  });
  it('allows delayed DCV setup beyond the Kubernetes budget', async () => {
    const f = await setup({ connectTimeoutMs: { dcv: 500, kubernetes: 20 } }, 'slow');
    expect(await within(f.start().result)).toMatchObject({ status: 200, body: 'connected', complete: true });
    expect(f.requests()).toBe(1);
  });
  it('retains the 15-second Kubernetes default', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const f = await setup({}, 'held', 'port-forward');
    const { req, result } = f.start(); await f.started;
    expect(timer.mock.calls.some(([, delay]) => delay === 15_000)).toBe(true);
    expect(timer.mock.calls.some(([, delay]) => delay === 60_000)).toBe(false);
    req.destroy(); await expect(result).rejects.toBeDefined();
  });
  it.each([false, true])('flushes a structured 504 before aborting timed-out DCV setup (upgrade=%s)', async upgrade => {
    const f = await setup({ connectTimeoutMs: { dcv: 40 } }, 'held');
    const result = await within(f.start(upgrade).result);
    expect(result).toMatchObject({ status: 504, body: '{"error":"DCV upstream connection timed out"}', complete: true });
    expect(result.headers['content-type']).toContain('application/json');
    expect(f.signal()?.aborted).toBe(true);
    f.release(); await new Promise(resolve => setImmediate(resolve));
    expect(f.closed()).toBe(1); expect(f.requests()).toBe(0);
  });
  it('aborts setup on client cancellation and releases a late DCV acquisition', async () => {
    const f = await setup({ connectTimeoutMs: { dcv: 500 } }, 'held');
    const { req, result } = f.start(); await f.started;
    const aborted = new Promise<void>(resolve => f.signal()!.addEventListener('abort', () => resolve(), { once: true }));
    req.destroy(); await within(aborted);
    await expect(result).rejects.toBeDefined();
    f.release(); await new Promise(resolve => setImmediate(resolve));
    expect(f.closed()).toBe(1); expect(f.requests()).toBe(0);
  });
  it('keeps Kubernetes on its own shorter budget and returns JSON on timeout', async () => {
    const f = await setup({ connectTimeoutMs: { dcv: 500, kubernetes: 30 } }, 'held', 'port-forward');
    expect(await within(f.start().result)).toMatchObject({ status: 504, body: '{"error":"Session upstream connection timed out"}', complete: true });
    expect(f.signal()?.aborted).toBe(true);
  });
});
