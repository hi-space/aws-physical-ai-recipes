import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config';
import { ssm } from '../aws/clients';
import { dcvRegistration } from './sessions';
import type { GetDcvUpstream } from '../gateway/types';

interface Tunnel { generation: string; port: number; child: ChildProcess; sessionId: string; users: number; idle?: NodeJS.Timeout; registration: NonNullable<Awaited<ReturnType<typeof dcvRegistration>>> }
const tunnels = new Map<string, { generation: string; promise: Promise<Tunnel> }>();
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function isListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function terminate(key: string, tunnel: Tunnel) {
  if (tunnels.get(key)?.generation === tunnel.generation) tunnels.delete(key);
  if (tunnel.idle) clearTimeout(tunnel.idle);
  tunnel.child.kill('SIGTERM');
  await ssm().send(new TerminateSessionCommand({ SessionId: tunnel.sessionId })).catch(() => undefined);
}
async function establish(key: string, target: string, generation: string): Promise<Tunnel> {
  const started = Date.now();
  const stage = (name: string, extra: Record<string, unknown> = {}) => console.info('[dcv-tunnel]', { session: key, stage: name, elapsedMs: Date.now() - started, ...extra });
  stage('request-session');
  const registration = await dcvRegistration();
  if (!registration || registration.instanceId !== target || target !== config().dcv?.instanceId) throw new Error('DCV target is not registered');
  const port = await freePort();
  const parameters = { Target: target, DocumentName: 'AWS-StartPortForwardingSession', Parameters: { portNumber: ['8443'], localPortNumber: [String(port)] } };
  const response = await ssm().send(new StartSessionCommand(parameters));
  if (!response.SessionId || !response.StreamUrl || !response.TokenValue) throw new Error('SSM did not create a connection');
  stage('session-opened');
  const child = spawn('session-manager-plugin', [
    JSON.stringify(response), config().region, 'StartSession', '', JSON.stringify(parameters), `https://ssm.${config().region}.amazonaws.com`,
  ], { stdio: 'ignore', shell: false });
  const tunnel: Tunnel = { generation, port, child, sessionId: response.SessionId, users: 0, registration };
  let failed = false;
  child.once('error', (error) => { failed = true; stage('connector-error', { code: (error as NodeJS.ErrnoException).code ?? error.name }); });
  child.once('exit', (code, signal) => { failed = true; stage('connector-exit', { code, signal }); if (tunnels.get(key)?.generation === generation) tunnels.delete(key); });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failed) throw new Error('SSM connector stopped');
      if (await isListening(port)) { stage('listening'); return tunnel; }
      await delay(250);
    }
    throw new Error('SSM connection did not become ready');
  } catch (error) { stage('setup-failed', { code: (error as Error).name }); await terminate(key, tunnel); throw error; }
}
export const getDcvUpstream: GetDcvUpstream = async (session, { signal }) => {
  if (signal.aborted || session.kind !== 'dcv' || !session.ssmTarget) throw new Error('DCV session ended');
  let entry = tunnels.get(session.id);
  if (!entry) {
    const generation = randomUUID();
    const promise = establish(session.id, session.ssmTarget, generation);
    entry = { generation, promise };
    tunnels.set(session.id, entry);
    promise.catch(() => { if (tunnels.get(session.id)?.generation === generation) tunnels.delete(session.id); });
  }
  const tunnel = await entry.promise;
  if (tunnel.idle) clearTimeout(tunnel.idle);
  tunnel.users++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (--tunnel.users === 0) tunnel.idle = setTimeout(() => { void terminate(session.id, tunnel); }, 30_000);
  };
  if (signal.aborted) { close(); throw new Error('DCV session ended'); }
  return { url: new URL(`https://127.0.0.1:${tunnel.port}/`), ca: tunnel.registration.certificate, servername: tunnel.registration.hostname, close };
};
export async function closeDcvTunnels() {
  await Promise.all([...tunnels.entries()].map(async ([key, entry]) => { try { await terminate(key, await entry.promise); } catch { /* failed connection */ } }));
}
