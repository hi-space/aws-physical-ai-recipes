import { createHash } from 'node:crypto';
import { Agent, createServer, request as requestHttp, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { authorizeCookie, consumeTicket } from './auth';
import { resolveRoute, type GatewayRoute } from './routing';
import { upstreamHeaders, downstreamHeaders } from './headers';
import { guardConnection } from './lifetime';
import { serveTerminal, terminalPage } from './terminal';
import { terminalAsset } from './assets';
import { GatewayError, type AuthOptions, type GatewayTransport, type GatewaySession, type GetDcvUpstream } from './types';

export interface GatewayOptions extends AuthOptions {
  transport?: GatewayTransport;
  getDcvUpstream?: GetDcvUpstream;
  /** Revocation check cadence, at most 5 seconds. Expiry uses its own exact deadline. */
  recheckMs?: number;
  dashboardOrigin?: string;
  assetDirectory?: string;
  /** DCV includes SSM establishment + TLS. Overrides also allow short local timeout tests. */
  connectTimeoutMs?: { dcv?: number; kubernetes?: number };
}

const defaultTransport: GatewayTransport = {
  connect: async (...args) => (await import('./kubernetes')).kubernetesTransport.connect(...args),
  exec: async (...args) => (await import('./kubernetes')).kubernetesTransport.exec(...args),
};
const noCache = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

function safeError(error: unknown): { status: number; message: string } {
  // Never serialize Kubernetes/AWS/SSM/Node errors: they may embed tokens, URLs or response bodies.
  return error instanceof GatewayError
    ? { status: error.status, message: error.message }
    : { status: 502, message: 'Session upstream unavailable' };
}

function sendError(res: ServerResponse, error: unknown, afterFlush?: () => void) {
  if (res.destroyed) { afterFlush?.(); return; }
  if (res.writableEnded) {
    if (res.writableFinished) afterFlush?.();
    else if (afterFlush) res.once('finish', afterFlush);
    return;
  }
  if (res.headersSent) { res.destroy(); afterFlush?.(); return; }
  if (afterFlush) res.once('finish', afterFlush);
  const { status, message } = safeError(error);
  res.writeHead(status, { ...noCache, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function rejectUpgrade(socket: Duplex, error: unknown, afterFlush?: () => void) {
  if (socket.destroyed) { afterFlush?.(); return; }
  const { status, message } = safeError(error);
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, afterFlush);
  socket.resume();
}

function requestUrl(req: IncomingMessage, options: GatewayOptions): { route: GatewayRoute; url: URL } {
  // Duplicate Host/Origin/Cookie fields are ambiguous across intermediaries.
  for (const name of ['host', 'origin', 'cookie']) {
    if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1) {
      throw new GatewayError(400, 'Ambiguous request headers');
    }
  }
  const path = req.url ?? '/';
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\#]/.test(path)) throw new GatewayError(400, 'Invalid request path');
  // resolveRoute derives the session (from host or the /s/<id> prefix) and validates the authority for the mode.
  const route = resolveRoute({ host: req.headers.host, path }, options);
  const origin = new URL(route.publicOrigin);
  const url = new URL(`${route.prefix}${route.rest}`, origin);
  if (url.origin !== origin.origin || url.pathname.startsWith('//')) throw new GatewayError(400, 'Invalid request path');
  return { route, url };
}

/** The dashboard's public origin is deployment configuration with no built-in default. When absent, launch
 * exchanges accept only same-origin/absent Origin headers and the DCV desktop cannot be embedded. */
function dashboardOrigin(options: GatewayOptions): string | undefined {
  const origin = options.dashboardOrigin ?? process.env.DASHBOARD_ORIGIN;
  if (origin && !/^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/i.test(origin)) throw new GatewayError(500, 'DASHBOARD_ORIGIN is malformed');
  return origin || undefined;
}

function checkOrigin(req: IncomingMessage, route: GatewayRoute, websocket: boolean, exchange: boolean, options: GatewayOptions) {
  const origin = req.headers.origin;
  const expected = route.publicOrigin;
  const dashboard = dashboardOrigin(options);
  if (origin && origin !== expected && !(exchange && dashboard && origin === dashboard)) throw new GatewayError(403, 'Origin is not authorized');
  if ((!['GET', 'HEAD'].includes(req.method ?? '') || websocket) && origin !== expected) {
    throw new GatewayError(403, 'Exact session Origin is required');
  }
  if (!exchange && req.headers['sec-fetch-site'] === 'cross-site') throw new GatewayError(403, 'Cross-site request is not authorized');
}

async function dcvConnection(session: GatewaySession, signal: AbortSignal, hook?: GetDcvUpstream): Promise<Duplex> {
  if (!hook) throw new GatewayError(501, 'DCV tunnel adapter is not configured');
  const target = await hook(session, { signal });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Adapter owns its refcount/tunnel lifecycle. Cleanup failures must not expose credentials.
    try { void Promise.resolve(target.close()).catch(() => undefined); } catch { /* cleanup best effort */ }
  };
  const url = target.url;
  if (!(url instanceof URL) || url.protocol !== 'https:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !target.servername || !/^[a-zA-Z0-9.-]+$/.test(target.servername)) {
    release();
    throw new GatewayError(503, 'DCV adapter must return a registered TLS loopback tunnel');
  }
  if (signal.aborted) { release(); throw new GatewayError(401, 'Session ended'); }
  const socket = connectTls({
    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
    servername: target.servername, ca: target.ca, rejectUnauthorized: true,
  });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  socket.once('close', () => { signal.removeEventListener('abort', abort); release(); });
  socket.on('error', () => undefined);
  try {
    await Promise.race([
      once(socket, 'secureConnect'),
      once(socket, 'close').then(() => { throw new GatewayError(502, 'DCV TLS connection closed'); }),
    ]);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

function serializeUpgrade(headers: OutgoingHttpHeaders): string {
  return Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
    .filter((v) => v !== undefined).map((v) => `${key}: ${v}\r\n`)).join('');
}

export function createGatewayServer(options: GatewayOptions = {}) {
  const transport = options.transport ?? defaultTransport;
  const terminalWs = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  const active = new Set<AbortController>();
  const server = createServer({ maxHeaderSize: 32_768 }, (req, res) => {
    void handleHttp(req, res).catch((error) => sendError(res, error));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 0; // Long uploads/streams are bounded by their authenticated session.
  server.keepAliveTimeout = 5_000;

  function lifetime(session: GatewaySession, req: IncomingMessage, route: GatewayRoute, peer: ServerResponse | Duplex) {
    const controller = new AbortController();
    active.add(controller);
    const cleanup = guardConnection(session, req.headers.cookie, route, controller, options);
    const abort = () => controller.abort();
    peer.once('close', abort);
    peer.once('error', abort);
    controller.signal.addEventListener('abort', () => {
      cleanup();
      active.delete(controller);
      // A failure response already flushed to the peer must not be turned into a reset.
      if (!peer.writableFinished) peer.destroy();
      peer.removeListener('close', abort);
      peer.removeListener('error', abort);
    }, { once: true });
    return controller;
  }

  async function openUpstream(session: GatewaySession, controller: AbortController): Promise<Duplex> {
    if (controller.signal.aborted) throw new GatewayError(401, 'Session ended');
    const isDcv = session.kind === 'dcv';
    const budget = isDcv ? options.connectTimeoutMs?.dcv ?? 60_000 : options.connectTimeoutMs?.kubernetes ?? 15_000;
    let timedOut = false;
    const pending = (isDcv
      ? dcvConnection(session, controller.signal, options.getDcvUpstream)
      : transport.connect(session, controller.signal)).then(stream => {
      stream.on('error', () => undefined);
      // A connector may resolve after timeout/cancellation despite the abort signal.
      if (timedOut || controller.signal.aborted) { stream.destroy(); throw new GatewayError(401, 'Session ended'); }
      return stream;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            // Reject first; the caller writes its 504 before aborting/cleaning the peer.
            reject(new GatewayError(504, isDcv ? 'DCV upstream connection timed out' : 'Session upstream connection timed out'));
          }, budget);
          timeout.unref();
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new GatewayError(401, 'Session ended'));
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  function outgoing(req: IncomingMessage, route: GatewayRoute, stream: Duplex, controller: AbortController, websocket = false) {
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => stream as Socket;
    const upstream = requestHttp({
      // The upstream is reached over `stream`; `path` is the prefix-stripped app path (route.rest).
      method: req.method, host: new URL(route.publicOrigin).host, path: route.rest,
      headers: upstreamHeaders(req.headers, route, websocket), agent,
    });
    const timeout = setTimeout(() => upstream.destroy(new GatewayError(504, 'Session upstream handshake timed out')), 15_000);
    timeout.unref();
    upstream.once('response', () => clearTimeout(timeout));
    upstream.once('upgrade', () => clearTimeout(timeout));
    upstream.once('close', () => clearTimeout(timeout));
    controller.signal.addEventListener('abort', () => { upstream.destroy(); stream.destroy(); agent.destroy(); }, { once: true });
    return upstream;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/health' && ['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(200, { ...noCache, 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    const { route, url } = requestUrl(req, options);
    // `/s/<id>` (no trailing slash) serves the session root, but the browser would resolve the page's
    // relative `./__gateway/...` assets against `/s/` → a foreign session. Normalize to the slash form
    // (preserving the query so `/s/<id>?ticket=…` still exchanges) before any upstream work.
    if (route.mode === 'path') {
      const afterPrefix = (req.url ?? '').slice(route.prefix.length);
      if (afterPrefix === '' || afterPrefix.startsWith('?')) {
        res.writeHead(308, { ...noCache, location: `${route.prefix}/${afterPrefix}` });
        res.end();
        return;
      }
    }
    const ticketParams = url.searchParams.getAll('ticket');
    checkOrigin(req, route, false, ticketParams.length > 0, options);
    if (ticketParams.length) {
      if (req.method !== 'GET' || ticketParams.length !== 1) throw new GatewayError(400, 'Invalid launch exchange');
      const exchange = await consumeTicket(ticketParams[0], route, options);
      url.searchParams.delete('ticket');
      // url.pathname already carries the prefix in path mode, so this is `${prefix}${rest without ticket}`.
      res.writeHead(303, { ...noCache, 'set-cookie': exchange.cookie, location: `${url.pathname}${url.search}` });
      res.end();
      return;
    }
    const session = await authorizeCookie(req.headers.cookie, route, options);
    if (session.kind === 'terminal') {
      if (['GET', 'HEAD'].includes(req.method ?? '') && ['/__gateway/assets/terminal.js', '/__gateway/assets/terminal.css'].includes(route.rest)) {
        const name = route.rest.endsWith('.js') ? 'terminal.js' : 'terminal.css';
        const asset = await terminalAsset(name, options.assetDirectory);
        res.writeHead(200, { ...noCache, 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? '' : asset);
        return;
      }
      if (route.rest !== '/' || !['GET', 'HEAD'].includes(req.method ?? '')) throw new GatewayError(404, 'Terminal endpoint not found');
      await Promise.all([terminalAsset('terminal.js', options.assetDirectory), terminalAsset('terminal.css', options.assetDirectory)]);
      res.writeHead(200, { ...noCache, 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? '' : terminalPage);
      return;
    }
    const controller = lifetime(session, req, route, res);
    try {
      const stream = await openUpstream(session, controller);
      const upstream = outgoing(req, route, stream, controller);
      upstream.once('response', (response) => {
        try {
          // DCV's web client sends X-Frame-Options: DENY; the dashboard embeds it (stage 3 live view), so the
          // gateway grants framing to the dashboard origin only. Other kinds keep the app's own policy.
          const embedder = session.kind === 'dcv' ? dashboardOrigin(options) : undefined;
          res.writeHead(response.statusCode ?? 502, downstreamHeaders(response.headers, route, false, route.rest, embedder));
          response.on('error', () => res.destroy());
          response.pipe(res);
        } catch (error) { response.destroy(); sendError(res, error); }
      });
      upstream.on('error', (error) => sendError(res, error));
      req.once('aborted', () => controller.abort());
      req.pipe(upstream);
    } catch (error) {
      sendError(res, error, () => controller.abort());
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => undefined);
    socket.pause();
    const { route, url } = requestUrl(req, options);
    checkOrigin(req, route, true, false, options);
    if (url.searchParams.has('ticket')) throw new GatewayError(400, 'Exchange ticket over HTTPS first');
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(String(req.headers['sec-websocket-key'] ?? ''))) {
      throw new GatewayError(400, 'Invalid WebSocket handshake');
    }
    const session = await authorizeCookie(req.headers.cookie, route, options);
    const controller = lifetime(session, req, route, socket);
    if (session.kind === 'terminal') {
      if (route.rest !== '/__gateway/terminal') throw new GatewayError(404, 'Terminal endpoint not found');
      terminalWs.handleUpgrade(req, socket, head, (ws) => { void serveTerminal(ws, session, transport, controller); });
      socket.resume();
      return;
    }
    let stream: Duplex;
    try { stream = await openUpstream(session, controller); }
    catch (error) { rejectUpgrade(socket, error, () => controller.abort()); return; }
    const upstream = outgoing(req, route, stream, controller, true);
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      try {
        const expected = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((v) => v.trim());
        if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected ||
          response.headers.upgrade?.toLowerCase() !== 'websocket' ||
          response.headers['sec-websocket-protocol'] && !protocols.includes(String(response.headers['sec-websocket-protocol']))) {
          throw new GatewayError(502, 'Invalid upstream WebSocket handshake');
        }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${serializeUpgrade(downstreamHeaders(response.headers, route, true, route.rest))}\r\n`);
        upstreamSocket.on('error', () => controller.abort());
        upstreamSocket.once('close', () => controller.abort());
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
        socket.resume();
      } catch (error) { upstreamSocket.destroy(); rejectUpgrade(socket, error); }
    });
    upstream.once('response', (response) => { response.destroy(); rejectUpgrade(socket, new GatewayError(502, 'Application WebSocket upgrade rejected')); });
    upstream.on('error', (error) => rejectUpgrade(socket, error));
    upstream.end();
  }

  server.on('upgrade', (req, socket, head) => { void handleUpgrade(req, socket, head).catch((error) => rejectUpgrade(socket, error)); });
  // CONNECT is never a supported route to a caller-chosen network destination.
  server.on('connect', (_req, socket) => rejectUpgrade(socket, new GatewayError(405, 'CONNECT is not supported')));
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    for (const controller of active) controller.abort();
    terminalWs.close();
    return close(callback);
  };
  return server;
}
