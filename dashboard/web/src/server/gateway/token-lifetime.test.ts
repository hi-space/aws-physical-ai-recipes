import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createGatewayServer } from './server';
import { consumeTicket, issueLaunchTicket } from './auth';
import { tokenFixture } from './token-fixtures.test-helpers';

const host = 'derived.apps.physical-ai.hi-yoo.com';
const servers: Server[] = [], browsers: WebSocket[] = [], websocketServers: WebSocketServer[] = [];
const sockets = new Set<Socket>();
const port = (server: Server) => (server.address() as AddressInfo).port;
async function listen(server: Server) {
  servers.push(server); server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server;
}
afterEach(async () => {
  for (const browser of browsers.splice(0)) browser.terminate();
  for (const wss of websocketServers.splice(0)) { for (const client of wss.clients) client.terminate(); wss.close(); }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
async function setup(shortExpiry = false) {
  const f = await tokenFixture();
  if (shortExpiry) {
    f.options.now = Date.now;
    const expiresAt = new Date(Date.now() + 500).toISOString();
    await f.changeToken({ expiresAt });
    f.session.expiresAt = expiresAt; f.session.tokenExpiresAt = expiresAt;
    await f.repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...f.session });
  }
  const upstream = await listen(createServer((_req, res) => { res.writeHead(200); res.write('active stream'); }));
  const wss = new WebSocketServer({ server: upstream }); websocketServers.push(wss);
  wss.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const gateway = await listen(createGatewayServer({ ...f.options, recheckMs: 20, transport: {
    connect: async (session, signal) => {
      expect(session.podName).toBe('owned-pod'); expect(session.port).toBe(8077);
      const socket = connect(port(upstream), '127.0.0.1');
      signal.addEventListener('abort', () => socket.destroy(), { once: true });
      await once(socket, 'connect'); return socket;
    }, exec: async () => { throw new Error('not used'); },
  } }));
  const launch = await issueLaunchTicket(f.session, f.principal, f.options);
  const cookie = (await consumeTicket(launch.ticket, host, f.options)).cookie.split(';')[0];
  async function open() {
    const ws = new WebSocket(`ws://127.0.0.1:${port(gateway)}/files`, { headers: { host, cookie, origin: `https://${host}` } });
    browsers.push(ws); await once(ws, 'open'); return ws;
  }
  return { ...f, gateway, cookie, open };
}

describe('live token-derived connections', () => {
  it.each(['revoked', 'cognito-role', 'project-role', 'project-namespace', 'token-role', 'cognito-unavailable'])('ends an existing WebSocket after %s changes', async (change) => {
    const f = await setup(); const ws = await f.open();
    const message = once(ws, 'message'); ws.send('before policy change');
    expect((await message)[0].toString()).toBe('before policy change');
    const closed = once(ws, 'close');
    if (change === 'revoked') await f.revoke();
    if (change === 'cognito-role') f.state.user.groups = ['viewers'];
    if (change === 'project-role') await f.repo.kv.put({ pk: f.ownerKey.pk, sk: 'META', ...f.project, members: { 'subject-a': 'viewer' } });
    if (change === 'project-namespace') await f.repo.kv.put({ pk: f.ownerKey.pk, sk: 'META', ...f.project, namespace: 'different' });
    if (change === 'token-role') await f.changeToken({ roleCeiling: 'viewer' });
    if (change === 'cognito-unavailable') f.state.failUser = true;
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    await expect(f.open()).rejects.toThrow();
  });
  it('ends an existing HTTP stream when the token is revoked', async () => {
    const f = await setup();
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: port(f.gateway), path: '/stream', headers: { host, cookie: f.cookie } }, resolve);
      req.on('error', reject); req.end();
    });
    expect(response.statusCode).toBe(200);
    response.on('error', () => undefined); response.resume();
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    await f.revoke(); await closed;
    expect(response.destroyed).toBe(true);
  });
  it('ends an established connection at the source-bound session expiry', async () => {
    const f = await setup(true); const ws = await f.open();
    await once(ws, 'close');
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(f.session.tokenExpiresAt!) - 10);
    await expect(f.open()).rejects.toThrow();
  });
});
