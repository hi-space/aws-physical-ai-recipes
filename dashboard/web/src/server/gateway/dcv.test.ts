import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGatewayServer } from './server';
import { issueLaunchTicket, consumeTicket } from './auth';
import { resolveRoute } from './routing';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { DcvUpstream, GatewaySession } from './types';

let fixture: string, ca: Buffer, key: Buffer;
let tls: Server;
let gateway: ReturnType<typeof createGatewayServer>;
const host = 'desktop.apps.physical-ai.hi-yoo.com';
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'pai-dcv-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  ca = readFileSync(join(fixture, 'cert.pem')); key = readFileSync(join(fixture, 'key.pem'));
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
afterEach(async () => {
  if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
  if (tls) await new Promise<void>((resolve) => tls.close(() => resolve()));
});

async function setup(change: (target: DcvUpstream) => DcvUpstream = (t) => t) {
  const repo = new Repo(new MemoryKV());
  const session: GatewaySession = { id: 'desktop', kind: 'dcv', namespace: 'research', ownerSubject: 'owner-sub',
    nodeName: 'real-node', ssmTarget: 'i-registered', dcvSessionId: 'user-session', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await repo.kv.put({ pk: 'SESS#desktop', sk: 'META', ...session });
  tls = createServer({ key, cert: ca }, (_req, res) => res.end('dcv upstream'));
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
  let closed = 0;
  let received: GatewaySession | undefined;
  gateway = createGatewayServer({ repo, dashboardOrigin: 'https://physical-ai.hi-yoo.com', getDcvUpstream: async (s) => {
    received = s;
    return change({ url: new URL(`https://127.0.0.1:${(tls.address() as AddressInfo).port}`), ca, servername: 'localhost', close: () => { closed++; } });
  } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
  const cookie = (await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, { repo }), { repo })).cookie.split(';')[0];
  return { closed: () => closed, received: () => received, get: () => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: (gateway.address() as AddressInfo).port, headers: { host, cookie } }, (res) => {
      let body = ''; res.on('data', (b) => { body += b; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  }) };
}

describe('DCV adapter boundary', () => {
  it('uses the actual registered target, verifies its TLS certificate and releases its tunnel lease', async () => {
    const dcv = await setup();
    expect(await dcv.get()).toEqual({ status: 200, body: 'dcv upstream' });
    expect(dcv.received()).toMatchObject({ nodeName: 'real-node', ssmTarget: 'i-registered', dcvSessionId: 'user-session' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dcv.closed()).toBe(1);
  });
  it('rejects a self-signed upstream without its registered CA', async () => {
    const dcv = await setup((target) => ({ ...target, ca: undefined }));
    const result = await dcv.get();
    expect(result.status).toBe(502);
    expect(result.body).toBe('{"error":"Session upstream unavailable"}');
  });
  it('rejects a certificate for another registered name', async () => {
    const dcv = await setup((target) => ({ ...target, servername: 'wrong.invalid' }));
    expect((await dcv.get()).status).toBe(502);
  });
  it.each(['http://127.0.0.1:8443', 'https://public.example:8443', 'https://127.0.0.1:8443/other'])('rejects unsupported tunnel location %s', async (url) => {
    const dcv = await setup((target) => ({ ...target, url: new URL(url) }));
    expect((await dcv.get()).status).toBe(503);
    expect(dcv.closed()).toBe(1);
  });
});
