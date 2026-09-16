import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { clusterInfo as sharedClusterInfo } from '../k8s/client';
import { runOnBackend } from '../backends/context';
import { mintEksToken } from '../k8s/token';
import { GatewayError, type GatewaySession, type GatewayTransport } from './types';

interface ClusterInfo { endpoint: string; ca: string; name: string; region: string }
interface KubernetesOptions {
  clusterInfo?: (session: GatewaySession) => Promise<ClusterInfo>;
  mintToken?: typeof mintEksToken;
}
const protocol = 'v4.channel.k8s.io';
const connectionError = () => new GatewayError(502, 'Kubernetes session connection failed');
async function clusterInfo(session: GatewaySession): Promise<ClusterInfo> {
  return runOnBackend(session, async () => {
    const cluster = await sharedClusterInfo();
    if (!cluster.privateEndpoint) throw new GatewayError(503, 'EKS private endpoint is required');
    return cluster;
  });
}

function podPath(session: GatewaySession, subresource: 'exec' | 'portforward'): string {
  // Also validate the adapter boundary: direct calls must never become arbitrary URL access.
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!label.test(session.namespace) || !session.podName || session.podName.length > 253 ||
    !session.podName.split('.').every((part) => label.test(part))) throw new GatewayError(503, 'Session pod is not registered');
  return `/api/v1/namespaces/${session.namespace}/pods/${session.podName}/${subresource}`;
}

function buffer(data: WebSocket.RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/**
 * Kubernetes v4.channel.k8s.io:
 * - exec: channel 0 stdin, 1 stdout, 2 stderr, 3 Status JSON, 4 TerminalSize JSON.
 * - portforward: channel 0 data, 1 errors; each begins with uint16 LE port.
 * Mirrors official kubernetes-client/javascript exec.ts/portforward.ts/web-socket-handler.ts.
 * No kubeconfig files, shell commands, process-wide TLS overrides, or in-cluster app credentials.
 */
export function createKubernetesTransport(options: KubernetesOptions = {}): GatewayTransport {
  async function socket(
    session: GatewaySession,
    path: string,
    signal: AbortSignal,
    message: (ws: WebSocket, frame: Buffer) => void,
    failure: () => void,
    closed: () => void,
  ): Promise<WebSocket> {
    const cluster = await (options.clusterInfo ?? clusterInfo)(session);
    const endpoint = new URL(cluster.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' ||
      endpoint.search || endpoint.hash || !cluster.ca) throw new GatewayError(503, 'Verified Kubernetes TLS endpoint is required');
    const { token } = await (options.mintToken ?? mintEksToken)(cluster.name, cluster.region);
    if (signal.aborted) throw new GatewayError(401, 'Session ended');
    endpoint.protocol = 'wss:';
    const ws = new WebSocket(`${endpoint.origin}${path}`, [protocol], {
      ca: Buffer.from(cluster.ca, 'base64'), rejectUnauthorized: true,
      headers: { authorization: `Bearer ${token}` },
      perMessageDeflate: false, maxPayload: 1_048_576, handshakeTimeout: 10_000,
      followRedirects: false,
    });
    const abort = () => ws.terminate();
    signal.addEventListener('abort', abort, { once: true });
    // Attach handlers before open; kubelet can send initial data immediately after upgrading.
    ws.on('message', (raw, binary) => {
      try {
        if (!binary) throw connectionError();
        message(ws, buffer(raw));
      } catch { failure(); ws.terminate(); }
    });
    ws.on('error', () => failure());
    ws.once('close', () => { signal.removeEventListener('abort', abort); closed(); });
    return new Promise<WebSocket>((resolve, reject) => {
      const failed = () => reject(connectionError());
      ws.once('error', failed);
      ws.once('close', failed);
      ws.once('open', () => {
        if (ws.protocol !== protocol || signal.aborted) { ws.terminate(); failed(); return; }
        ws.removeListener('error', failed);
        ws.removeListener('close', failed);
        resolve(ws);
      });
    });
  }

  return {
    async connect(session, signal) {
      if (!Number.isInteger(session.port) || session.port! < 1 || session.port! > 65535) {
        throw new GatewayError(503, 'Session port is not registered');
      }
      const path = `${podPath(session, 'portforward')}?ports=${session.port}`;
      let ws: WebSocket | undefined;
      let open = false;
      const portBytes: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];
      const initialized = [false, false];
      const stream = new Duplex({
        read() { ws?.resume(); },
        write(chunk: Buffer, _encoding, callback) {
          if (ws?.readyState !== WebSocket.OPEN) { callback(connectionError()); return; }
          ws.send(Buffer.concat([Buffer.from([0]), chunk]), { binary: true }, (error) => callback(error ? connectionError() : undefined));
        },
        final(callback) { ws?.close(); callback(); },
        destroy(error, callback) { ws?.terminate(); callback(error); },
      });
      // A transport error can arrive during the handshake, before a caller can attach its own handler.
      stream.on('error', () => undefined);
      const fail = () => stream.destroy(connectionError());
      try {
        ws = await socket(session, path, signal, (remote, frame) => {
          if (!frame.length || frame[0] > 1) throw connectionError();
          const channel = frame[0];
          let data = frame.subarray(1);
          if (!initialized[channel]) {
            data = Buffer.concat([portBytes[channel], data]);
            if (data.length < 2) { portBytes[channel] = data; return; }
            if (data.readUInt16LE(0) !== session.port) throw connectionError();
            initialized[channel] = true;
            data = data.subarray(2);
          }
          if (!data.length) return;
          if (channel === 1) { fail(); remote.terminate(); return; }
          if (!stream.push(data)) remote.pause();
        }, fail, () => {
          if (!open) fail();
          else stream.push(null);
        });
        open = true;
        if (stream.destroyed || signal.aborted) { ws.terminate(); throw connectionError(); }
        return stream;
      } catch {
        stream.destroy();
        throw connectionError();
      }
    },
    async exec(session, callbacks, signal) {
      if (!session.container || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(session.container) || session.container.length > 63) {
        throw new GatewayError(503, 'Terminal container is not registered');
      }
      const query = new URLSearchParams({
        container: session.container, command: '/bin/sh', stdin: 'true', stdout: 'true', stderr: 'true', tty: 'true',
      });
      const path = `${podPath(session, 'exec')}?${query}`;
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      let ended = false;
      const fail = () => { if (!ended && !signal.aborted) { ended = true; callbacks.error(); } };
      const ws = await socket(session, path, signal, (remote, frame) => {
        if (ended || !frame.length) return;
        const data = frame.subarray(1);
        if (frame[0] === 1) { const text = stdout.write(data); if (text) callbacks.stdout(text); }
        else if (frame[0] === 2) { const text = stderr.write(data); if (text) callbacks.stderr(text); }
        else if (frame[0] === 3) {
          const status = JSON.parse(data.toString('utf8')) as { status?: string; details?: { causes?: Array<{ reason?: string; message?: string }> } };
          const exit = status.details?.causes?.find((cause) => cause.reason === 'ExitCode')?.message;
          const code = status.status === 'Success' ? 0 : exit && /^\d+$/.test(exit) ? Number(exit) : 1;
          ended = true;
          const out = stdout.end(), err = stderr.end();
          if (out) callbacks.stdout(out);
          if (err) callbacks.stderr(err);
          callbacks.exit(code);
          remote.close();
        } else throw connectionError();
      }, fail, fail);
      const send = (channel: number, data: string) => {
        if (ended || signal.aborted || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1_048_576) { fail(); ws.terminate(); return; }
        ws.send(Buffer.concat([Buffer.from([channel]), Buffer.from(data)]), { binary: true }, (error) => { if (error) fail(); });
      };
      return {
        input: (data) => send(0, data),
        resize: (cols, rows) => send(4, JSON.stringify({ Width: cols, Height: rows })),
        close: () => { ended = true; ws.terminate(); },
      };
    },
  };
}

export const kubernetesTransport = createKubernetesTransport();
