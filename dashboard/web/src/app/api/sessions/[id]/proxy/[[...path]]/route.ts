import type { NextRequest } from 'next/server';
import { sessionFromHeaders, type Session } from '@/server/auth/session';
import { sanitizeProxyPath, serviceProxy } from '@/server/k8s/client';
import { getRepo } from '@/server/store/repo';
export const dynamic = 'force-dynamic';

/**
 * Reverse proxy to a session's in-cluster Service via the Kubernetes API server.
 * TensorBoard sessions are team-readable (GET/HEAD for any authenticated user);
 * every other method, and every other session kind, requires the owner or an admin.
 */
async function handle(req: NextRequest, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  let user: Session;
  try {
    user = sessionFromHeaders(req.headers);
  } catch {
    return new Response('unauthorized', { status: 401 });
  }
  const { id, path = [] } = await ctx.params;
  if (!/^[a-f0-9]{6}$/.test(id)) return new Response('bad session id', { status: 400 });
  const s = await getRepo().getSession(id);
  if (!s) return new Response('session not found', { status: 404 });
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  const isOwner = s.owner === user.user || user.role === 'admin';
  if (!(s.kind === 'tensorboard' && readOnly) && !isOwner) return new Response('forbidden', { status: 403 });
  const port = s.kind === 'tensorboard' ? 6006 : 8888;
  const safePath = sanitizeProxyPath(path);
  if (safePath === null) return new Response('bad path', { status: 400 });
  const sub = `/api/sessions/${id}/proxy/${safePath}${req.nextUrl.search}`;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(k) && !k.startsWith('x-amzn') && !k.startsWith('x-pai')) headers[k] = v;
  });
  const bodyBuf = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
  const res = await serviceProxy(s.namespace, s.name, port, sub, { method: req.method, headers, body: bodyBuf });
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) out.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers: out });
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as HEAD };
