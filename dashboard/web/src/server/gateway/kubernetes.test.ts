import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createKubernetesTransport } from './kubernetes';
import type { GatewaySession } from './types';

let fixture: string;
let cert: Buffer;
let key: Buffer;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let controller: AbortController;
const session: GatewaySession = { id: 'job', kind: 'port-forward', namespace: 'research', podName: 'job-pod', container: 'main',
  ownerSubject: 'sub', port: 8888, expiresAt: '2099-01-01T00:00:00Z' };
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'pai-gateway-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  cert = readFileSync(join(fixture, 'cert.pem')); key = readFileSync(join(fixture, 'key.pem'));
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
afterEach(async () => {
  controller?.abort();
  for (const ws of wss?.clients ?? []) ws.terminate();
  wss?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined; wss = undefined;
});
async function setup(onConnection: (ws: WebSocket, req: import('node:http').IncomingMessage) => void, trusted = true) {
  controller = new AbortController();
  server = createServer({ key, cert });
  wss = new WebSocketServer({ server, handleProtocols: (protocols) => protocols.has('v4.channel.k8s.io') && 'v4.channel.k8s.io' });
  wss.on('connection', onConnection);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return createKubernetesTransport({
    clusterInfo: async () => ({ endpoint: `https://127.0.0.1:${(server!.address() as AddressInfo).port}`, ca: trusted ? cert.toString('base64') : '', name: 'research', region: 'us-east-1' }),
    mintToken: async () => ({ token: 'synthetic-test-token', expiresAt: Date.now() + 60_000 }),
  });
}

describe('Kubernetes gateway streaming protocol over verified TLS', () => {
  it('forwards only the registered pod/port and transports unmodified TCP bytes on channel zero', async () => {
    let request: import('node:http').IncomingMessage | undefined;
    const transport = await setup((ws, req) => {
      request = req;
      ws.send(Buffer.from([0, 0xb8, 0x22])); // 8888 LE, first message on data channel.
      ws.on('message', (data) => {
        const bytes = Buffer.from(data as Buffer);
        expect(bytes[0]).toBe(0);
        ws.send(Buffer.concat([Buffer.from([0]), bytes.subarray(1)]));
      });
    });
    const stream = await transport.connect(session, controller.signal);
    const read = once(stream, 'data');
    stream.write(Buffer.from('GET /lab HTTP/1.1\r\nHost: app\r\n\r\n'));
    expect((await read)[0].toString()).toBe('GET /lab HTTP/1.1\r\nHost: app\r\n\r\n');
    expect(request?.url).toBe('/api/v1/namespaces/research/pods/job-pod/portforward?ports=8888');
    expect(request?.headers.authorization).toBe('Bearer synthetic-test-token');
    stream.destroy();
  });
  it('sends Exec stdin/resize and decodes stdout/stderr/exit using the Kubernetes channels', async () => {
    let request: import('node:http').IncomingMessage | undefined;
    let remote: WebSocket;
    const transport = await setup((ws, req) => { remote = ws; request = req; });
    const stdout: string[] = [], stderr: string[] = [];
    let exit: number | undefined;
    const connection = await transport.exec({ ...session, kind: 'terminal' }, {
      stdout: (data) => stdout.push(data), stderr: (data) => stderr.push(data), exit: (code) => { exit = code; }, error: () => undefined,
    }, controller.signal);
    const input = once(remote!, 'message'); connection.input('echo hello\n');
    expect((await input)[0]).toEqual(Buffer.concat([Buffer.from([0]), Buffer.from('echo hello\n')]));
    const resize = once(remote!, 'message'); connection.resize(132, 43);
    const frame = (await resize)[0] as Buffer;
    expect(frame[0]).toBe(4); expect(JSON.parse(frame.subarray(1).toString())).toEqual({ Width: 132, Height: 43 });
    remote!.send(Buffer.concat([Buffer.from([1]), Buffer.from('hello')]));
    remote!.send(Buffer.concat([Buffer.from([2]), Buffer.from('stderr')]));
    remote!.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '7' }] } }))]));
    await new Promise<void>((resolve) => remote!.once('close', () => resolve()));
    expect(stdout.join('')).toBe('hello'); expect(stderr.join('')).toBe('stderr'); expect(exit).toBe(7);
    const url = new URL(request!.url!, 'https://localhost');
    expect(url.pathname).toBe('/api/v1/namespaces/research/pods/job-pod/exec');
    expect(url.searchParams.get('container')).toBe('main');
    expect(url.searchParams.getAll('command')).toEqual(['/bin/sh']);
    expect(url.searchParams.get('tty')).toBe('true');
    connection.close();
  });
  it('does not turn an untrusted cluster certificate into a working connection', async () => {
    const transport = await setup(() => undefined, false);
    await expect(transport.connect(session, controller.signal)).rejects.toBeDefined();
  });
  it('closes the port-forward when the API sends an error and does not expose its payload', async () => {
    let remote: WebSocket;
    const transport = await setup((ws) => { remote = ws; });
    const stream = await transport.connect(session, controller.signal);
    const error = once(stream, 'error');
    remote!.send(Buffer.concat([Buffer.from([1, 0xb8, 0x22]), Buffer.from('secret backend details')]));
    expect(String((await error)[0])).not.toContain('secret backend details');
  });
});
