import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { audit } from './audit';
import { requireRole, sessionFromHeaders, type Session } from './auth/session';
import type { Role } from './auth/rbac';
import { HttpError, badRequest } from './errors';

export type Ctx<P = Record<string, string>> = { req: NextRequest; session: Session; params: P; url: URL };
type Handler<P> = (ctx: Ctx<P>) => Promise<unknown>;

/**
 * Wrap a Route Handler: resolves the session (set by proxy.ts), enforces the
 * minimum role, awaits Next 16 async params, serialises the result and maps
 * errors to JSON. Mutations (non-GET) are audited automatically.
 */
export function route<P extends Record<string, string> = Record<string, string>>(minRole: Role, handler: Handler<P>, opts: { audit?: string } = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    let session: Session | undefined;
    const params = await ctx.params;
    const action = opts.audit ?? `${req.method} ${req.nextUrl.pathname}`;
    try {
      session = sessionFromHeaders(req.headers);
      requireRole(session, minRole);
      const result = await handler({ req, session, params, url: req.nextUrl });
      if (result instanceof Response) return result;
      if (req.method !== 'GET') void audit(session, action, targetOf(params, req), 'ok');
      return NextResponse.json(result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) console.error(`[api] ${req.method} ${req.nextUrl.pathname}`, e);
      if (session && req.method !== 'GET') void audit(session, action, targetOf(params, req), 'error', message);
      return NextResponse.json({ error: message, code: e instanceof HttpError ? e.code : 'internal', details: e instanceof HttpError ? e.details : undefined }, { status });
    }
  };
}

function targetOf(params: Record<string, string>, req: NextRequest): string | undefined {
  const vals = Object.values(params);
  return vals.length ? vals.join('/') : req.nextUrl.searchParams.toString() || undefined;
}

export async function body<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('Invalid request', { issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  return r.data;
}

export const q = (url: URL, key: string): string | undefined => url.searchParams.get(key) ?? undefined;
export const qInt = (url: URL, key: string, def: number): number => {
  const v = url.searchParams.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Server-Sent Events response from an async generator. */
export function sse(gen: AsyncGenerator<{ event?: string; data: unknown }>, signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => controller.close();
      signal?.addEventListener('abort', onAbort);
      try {
        for await (const msg of gen) {
          if (signal?.aborted) break;
          controller.enqueue(enc.encode(`${msg.event ? `event: ${msg.event}\n` : ''}data: ${JSON.stringify(msg.data)}\n\n`));
        }
      } catch (e) {
        controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`));
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
