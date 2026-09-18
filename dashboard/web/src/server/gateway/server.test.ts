import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { issueLaunchTicket, consumeTicket } from './auth';
import { createGatewayServer } from './server';
import type { GatewaySession, GatewayTransport } from './types';

const host = 'local.apps.physical-ai.hi-yoo.com';
const origin = `https://${host}`;
let repo: Repo;
let session: GatewaySession;
let servers: Server[];
let sockets: Set<Socket>;
let browsers: WebSocket[];
let upstream: Server;
let gateway: Server;
let cookie: string;
let seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[];
let connects: GatewaySession[];
let assetDirectory: string;
const port = (server: Server) => (server.address() as AddressInfo).port;
async function listen(server: Server) {
  servers.push(server);
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
async function request(path = '/', headers: Record<string, string> = {}, method = 'GET', body = '') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: port(gateway), path, method, headers: { host, cookie, ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function openWs(path: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port(gateway)}${path}`, ['jupyter-v1'], { headers: { host, cookie, origin, ...headers } });
  browsers.push(ws);
  await once(ws, 'open');
  return ws;
}
beforeEach(async () => {
  repo = new Repo(new MemoryKV()); servers = []; sockets = new Set(); browsers = []; seen = []; connects = [];
  assetDirectory = await mkdtemp(join(tmpdir(), 'pai-terminal-assets-'));
  await writeFile(join(assetDirectory, 'terminal.js'), '/* locally bundled xterm */');
  await writeFile(join(assetDirectory, 'terminal.css'), '.xterm { color: white; }');
  session = { id: 'local', kind: 'jupyter', namespace: 'research', podName: 'registered-pod', container: 'main', port: 8888,
    ownerSubject: 'owner-sub', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session });
  upstream = await listen(createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://localhost:8888/lab?next=ok', 'set-cookie': [
          'app=abc; Domain=.physical-ai.hi-yoo.com; Path=/lab; HttpOnly',
          '__Host-pai-session=overwritten; Path=/; Secure; HttpOnly',
        ] });
        res.end();
      } else if (req.url === '/folder/page') {
        res.writeHead(302, { location: 'next?file=a%20b' }); res.end();
      } else if (req.url === '/stream') {
        res.writeHead(200); res.write('start');
      } else {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(body || 'upstream');
      }
    });
  }));
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: '' });
    wss.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (data, binary) => ws.send(data, { binary })); });
  });
  const transport: GatewayTransport = {
    connect: async (s, signal) => {
      connects.push(s);
      const socket = connect(port(upstream), '127.0.0.1');
      signal.addEventListener('abort', () => socket.destroy(), { once: true });
      await once(socket, 'connect'); return socket;
    },
    exec: async () => { throw new Error('not used'); },
  };
  gateway = await listen(createGatewayServer({ repo, dashboardOrigin: 'https://physical-ai.hi-yoo.com', transport, recheckMs: 20, assetDirectory }));
  const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
  cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
});
afterEach(async () => {
  for (const ws of browsers) ws.terminate();
  for (const s of sockets) s.destroy();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(assetDirectory, { recursive: true, force: true });
});

describe('session HTTP and websocket gateway', () => {
  it('serves health without auth and never contacts the upstream', async () => {
    expect((await request('/health', { host: '127.0.0.1', cookie: '' })).status).toBe(200);
    expect(connects).toHaveLength(0);
  });
  it('exchanges a ticket into a host-only cookie and scrubs the URL before proxying', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    const result = await request(`/lab?ticket=${launch.ticket}&theme=dark`, { cookie: '' });
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe('/lab?theme=dark');
    expect(result.headers['set-cookie']?.[0]).toContain('__Host-pai-session=');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(connects).toHaveLength(0);
  });
  it('rejects a normalized scheme-relative launch redirect without consuming its ticket', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    expect((await request(`/a/..//evil.test/?ticket=${launch.ticket}`, { cookie: '' })).status).toBe(400);
    expect((await request(`/?ticket=${launch.ticket}`, { cookie: '' })).status).toBe(303);
  });
  it('preserves method, escaped path/query, body and application cookies while removing identities', async () => {
    const result = await request('/api/files/a%20b?target=http://evil.test&port=9999', {
      origin, cookie: `${cookie}; app=one; _xsrf=two; AWSELBAuthSessionCookie-0=secret; pai-project=p`,
      authorization: 'Bearer never-upstream', 'x-amzn-oidc-data': 'jwt-secret', 'x-pai-subject': 'other',
      'x-forwarded-host': 'evil.test', 'x-forwarded-for': '1.2.3.4', 'x-xsrftoken': 'two',
      'content-type': 'text/plain',
    }, 'POST', 'payload=hello');
    expect(result).toMatchObject({ status: 200, body: 'payload=hello' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/files/a%20b?target=http://evil.test&port=9999', body: 'payload=hello' });
    expect(seen[0].headers).toMatchObject({ host, cookie: 'app=one; _xsrf=two', 'x-xsrftoken': 'two', 'x-forwarded-proto': 'https' });
    for (const header of ['authorization', 'x-amzn-oidc-data', 'x-pai-subject', 'x-forwarded-for']) expect(seen[0].headers[header]).toBeUndefined();
    expect(connects[0]).toMatchObject({ podName: 'registered-pod', port: 8888 });
  });
  it('keeps redirects and upstream cookies on the isolated host', async () => {
    const result = await request('/redirect');
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`https://${host}/lab?next=ok`);
    expect(result.headers['set-cookie']).toEqual(['app=abc; Path=/lab; HttpOnly; Secure']);
  });
  it('resolves relative redirects against the current app path and preserves query encoding', async () => {
    const result = await request('/folder/page');
    expect(result.headers.location).toBe(`https://${host}/folder/next?file=a%20b`);
  });
  it('requires exact Origin for unsafe HTTP and rejects supplied sibling Origin on GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await request('/', {}, method)).status).toBe(403);
      expect((await request('/', { origin: 'https://sibling.apps.physical-ai.hi-yoo.com' }, method)).status).toBe(403);
    }
    expect((await request('/', { origin: 'https://physical-ai.hi-yoo.com' })).status).toBe(403);
    expect(connects).toHaveLength(0);
  });
  it('rejects forged forwarded host and missing auth', async () => {
    expect((await request('/', { host: 'evil.test', 'x-forwarded-host': host })).status).toBe(401);
    expect((await request('/', { cookie: '', 'x-pai-subject': 'owner-sub' })).status).toBe(401);
    expect(connects).toHaveLength(0);
  });
  it('proxies WebSocket path, app subprotocol, headers, text and binary through the registered target', async () => {
    const ws = await openWs('/api/kernels/1/channels?session_id=a', { cookie: `${cookie}; app=ok`, 'x-amzn-oidc-data': 'secret' });
    expect(ws.protocol).toBe('jupyter-v1');
    const text = once(ws, 'message'); ws.send('hello');
    expect((await text)[0].toString()).toBe('hello');
    const binary = once(ws, 'message'); ws.send(Buffer.from([0, 1, 255]));
    const [data, isBinary] = await binary;
    expect(data).toEqual(Buffer.from([0, 1, 255])); expect(isBinary).toBe(true);
    expect(seen[0].url).toBe('/api/kernels/1/channels?session_id=a');
    expect(seen[0].headers.cookie).toBe('app=ok');
    expect(seen[0].headers['x-amzn-oidc-data']).toBeUndefined();
  });
  it('rejects missing and sibling WebSocket Origin before opening upstream', async () => {
    await expect(openWs('/ws', { origin: '' })).rejects.toThrow();
    await expect(openWs('/ws', { origin: 'https://sibling.apps.physical-ai.hi-yoo.com' })).rejects.toThrow();
    expect(connects).toHaveLength(0);
  });
  it('disconnects an already upgraded websocket on revocation', async () => {
    const ws = await openWs('/ws');
    const closed = once(ws, 'close');
    await repo.deleteSession(session.id);
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('disconnects an already upgraded websocket when the registered target changes', async () => {
    const ws = await openWs('/ws');
    const closed = once(ws, 'close');
    await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session, podName: 'replacement-pod' });
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('disconnects an already upgraded websocket when the session store is unavailable', async () => {
    const ws = await openWs('/ws');
    const closed = once(ws, 'close');
    repo.kv.get = async () => { throw new Error('simulated store outage'); };
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('expires existing WebSockets at the deadline and denies reconnect', async () => {
    session.expiresAt = new Date(Date.now() + 180).toISOString();
    await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session });
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
    const ws = await openWs('/ws');
    await once(ws, 'close');
    await expect(openWs('/ws')).rejects.toThrow();
  });
  it('ends active HTTP streams at session expiry', async () => {
    session.expiresAt = new Date(Date.now() + 250).toISOString();
    await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session });
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: port(gateway), path: '/stream', headers: { host, cookie } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.resume(); res.once('close', resolve);
      });
      req.on('error', reject); req.end();
    });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(session.expiresAt) - 10);
  });
  it('reports DCV unsupported without an actual tunnel adapter', async () => {
    session = { ...session, kind: 'dcv', nodeName: 'gpu-node', ssmTarget: 'i-owned', dcvSessionId: 'owner-session' };
    await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session });
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
    expect((await request('/')).status).toBe(501);
    expect(connects).toHaveLength(0);
  });
  it('serves only authenticated local terminal assets and reports missing bundles', async () => {
    session = { ...session, kind: 'terminal' };
    await repo.kv.put({ pk: 'SESS#local', sk: 'META', ...session });
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, { repo });
    cookie = (await consumeTicket(launch.ticket, host, { repo })).cookie.split(';')[0];
    expect((await request('/__gateway/assets/terminal.js', { cookie: '' })).status).toBe(401);
    const asset = await request('/__gateway/assets/terminal.js');
    expect(asset.status).toBe(200); expect(asset.body).toBe('/* locally bundled xterm */');
    expect((await request('/__gateway/assets/other.js')).status).toBe(404);
    const page = await request('/');
    expect(page.body).toContain('/__gateway/assets/terminal.js');
    expect(page.body).not.toContain('line input');
    await rm(join(assetDirectory, 'terminal.js'));
    expect((await request('/')).status).toBe(503);
  });
});
