import type { NextRequest } from 'next/server';
import { sessionFromHeaders } from '@/server/auth/session';
import { sanitizeProxyPath, serviceProxy } from '@/server/k8s/client';
import { readSecret } from '@/server/k8s/resources';
export const dynamic = 'force-dynamic';

let creds: Promise<string> | undefined;
/** Grafana admin basic-auth header, from the in-cluster `grafana` Secret. */
function grafanaAuth(): Promise<string> {
  creds ??= readSecret('grafana', 'grafana').then((s) => 'Basic ' + Buffer.from(`${s['admin-user'] ?? 'admin'}:${s['admin-password'] ?? ''}`).toString('base64'));
  creds.catch(() => (creds = undefined));
  return creds;
}

/**
 * The self-hosted Grafana from HyperPodEks is configured with
 * root_url=/absproxy/3000/ (for code-server). Serving the same path here lets
 * us proxy it through the Kubernetes API server without any network change.
 */
async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  try {
    sessionFromHeaders(req.headers);
  } catch {
    return new Response('unauthorized', { status: 401 });
  }
  const { path = [] } = await ctx.params;
  const safePath = sanitizeProxyPath(path);
  if (safePath === null) return new Response('bad path', { status: 400 });
  const sub = `/${safePath}${req.nextUrl.search}`;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!['host', 'connection', 'content-length', 'accept-encoding', 'cookie', 'authorization'].includes(k) && !k.startsWith('x-amzn') && !k.startsWith('x-pai')) headers[k] = v;
  });
  headers.authorization = await grafanaAuth();
  const bodyBuf = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
  const res = await serviceProxy('grafana', 'grafana', 80, sub, { method: req.method, headers, body: bodyBuf });
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!['content-encoding', 'transfer-encoding', 'connection', 'content-security-policy', 'x-frame-options'].includes(k)) out.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers: out });
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as HEAD };
