import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../errors';
import type { RuntimeBroker } from './broker';
const MAX_BODY = 2 * 1024 * 1024;
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON content type required');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'Runtime request exceeds size limit');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) throw new HttpError(413, 'Runtime request exceeds size limit');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON request');
  }
}
function send(res: ServerResponse, status: number, body?: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.setHeader('cache-control', 'no-store');
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_BODY) {
    res.writeHead(413, {
      'content-type': 'application/json'
    });
    res.end(JSON.stringify({
      error: 'Runtime response exceeds size limit'
    }));
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json'
  });
  res.end(text);
}
export function createRuntimeHandler(broker: RuntimeBroker) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url?.startsWith('/runtime/')) return false;
    const controller = new AbortController();
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', closed);
    try {
      const authCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization').length;
      const authorization = req.headers.authorization;
      if (authCount !== 1 || typeof authorization !== 'string' || !/^Bearer v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) throw new HttpError(401, 'Invalid runtime capability');
      const token = authorization.slice(7);
      await broker.authenticate(token);
      const url = new URL(req.url, 'http://runtime');
      if (!url.pathname.startsWith('/runtime/')) throw new HttpError(400, 'Invalid runtime path');
      if (req.method === 'POST' && url.pathname === '/runtime/state') {
        await broker.state(token, await jsonBody(req));
        send(res, 204);
      } else if (req.method === 'POST' && url.pathname === '/runtime/heartbeat') {
        await jsonBody(req);
        await broker.heartbeat(token);
        send(res, 204);
      } else if (req.method === 'GET' && url.pathname === '/runtime/barrier') {
        const replica = url.searchParams.get('replica');
        if (replica === null || !/^(0|[1-9][0-9]*)$/.test(replica) || url.searchParams.getAll('replica').length !== 1) throw new HttpError(400, 'Invalid replica index');
        send(res, 200, await broker.barrier(token, Number(replica)));
      } else if (req.method === 'GET' && url.pathname === '/runtime/checkpoints') {
        const replica = url.searchParams.get('replica');
        if (replica === null || !/^(0|[1-9][0-9]*)$/.test(replica) || url.searchParams.getAll('replica').length !== 1) throw new HttpError(400, 'Invalid replica index');
        send(res, 200, await broker.checkpoints(token, Number(replica), controller.signal));
      } else if (req.method === 'POST' && url.pathname === '/runtime/uploads') send(res, 200, await broker.planUploads(token, await jsonBody(req)));else if (req.method === 'POST' && url.pathname === '/runtime/uploads/complete') send(res, 200, await broker.completeUploads(token, await jsonBody(req), controller.signal));else if (req.method === 'GET' && url.pathname === '/runtime/inputs') send(res, 200, await broker.inputs(token));else send(res, 404, {
        error: 'Unknown runtime endpoint'
      });
    } catch (error) {
      // Never log request headers, payloads, raw SDK errors, signed URLs, or capability values.
      const known = error instanceof HttpError;
      send(res, known ? error.status : 503, {
        error: known ? error.message : 'Runtime dependency unavailable',
        code: known ? error.code : 'runtime_unavailable'
      });
    } finally {
      res.removeListener('close', closed);
    }
    return true;
  };
}
