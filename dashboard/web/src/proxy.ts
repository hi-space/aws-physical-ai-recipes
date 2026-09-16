import { NextResponse, type NextRequest } from 'next/server';
import { readGroupsFromAccessToken, verifyAlbOidcData } from '@/server/auth/alb-jwt';
import { roleFromGroups } from '@/server/auth/rbac';
import { SESSION_HEADERS } from '@/server/auth/session';
import { decodeJwt } from 'jose';
import { verifyApiToken } from '@/server/auth/api-tokens';

const PUBLIC_PATHS = ['/api/health', '/api/logout'];

/**
 * Next.js 16 request boundary. Turns the ALB's Cognito identity headers into
 * trusted x-pai-* headers for Route Handlers and Server Components. In dev mode
 * (AUTH_MODE=dev) every request is an admin.
 */
export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith('/_next/')) return NextResponse.next();

  const headers = new Headers(req.headers);
  // Never trust client-supplied session headers.
  for (const h of Object.values(SESSION_HEADERS)) headers.delete(h);
  if (pathname.startsWith('/api/v1/')) {
    try {
      const authorization = req.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ')) return deny(req, 'API token required');
      const canonicalPath = pathname.replace(/^\/api\/v1\//, '/api/');
      const principal = await verifyApiToken(authorization.slice(7), req.method, canonicalPath);
      headers.set(SESSION_HEADERS.user, principal.user);
      headers.set(SESSION_HEADERS.subject, principal.subject);
      headers.set(SESSION_HEADERS.email, principal.email);
      headers.set(SESSION_HEADERS.role, principal.role);
      headers.set(SESSION_HEADERS.authMethod, 'token');
      headers.set(SESSION_HEADERS.tokenProjectId, principal.tokenProjectId);
      headers.set(SESSION_HEADERS.scopes, principal.scopes.join(','));
      headers.set(SESSION_HEADERS.tokenId, principal.tokenId);
      headers.set('x-pai-project', principal.tokenProjectId);
      headers.delete('authorization');
      const destination = req.nextUrl.clone();
      destination.pathname = canonicalPath;
      return NextResponse.rewrite(destination, { request: { headers } });
    } catch { return deny(req, 'Invalid, expired, or unauthorized API token'); }
  }

  const authMode = process.env.AUTH_MODE ?? 'alb';
  if (authMode === 'dev') {
    if (process.env.NODE_ENV === 'production' || process.env.AWS_EXECUTION_ENV || process.env.ECS_CONTAINER_METADATA_URI_V4) {
      return deny(req, 'Development authentication is unavailable in deployed environments');
    }
    headers.set(SESSION_HEADERS.user, process.env.DEV_USER ?? 'dev');
    headers.set(SESSION_HEADERS.subject, process.env.DEV_USER ?? 'dev');
    headers.set(SESSION_HEADERS.email, 'dev@local');
    headers.set(SESSION_HEADERS.role, process.env.DEV_ROLE ?? 'admin');
    headers.set(SESSION_HEADERS.authMethod, 'alb');
    return NextResponse.next({ request: { headers } });
  }

  const oidcData = req.headers.get('x-amzn-oidc-data');
  const accessToken = req.headers.get('x-amzn-oidc-accesstoken') ?? '';
  if (!oidcData) return deny(req, 'Missing identity headers (request did not come through the ALB)');
  try {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const pool = process.env.COGNITO_USER_POOL_ID ?? '';
    const client = process.env.COGNITO_CLIENT_ID;
    const id = await verifyAlbOidcData(oidcData, region, {
      expectedSigner: process.env.ALB_ARN ?? '',
      expectedIssuer: pool ? `https://cognito-idp.${region}.amazonaws.com/${pool}` : undefined,
      expectedClient: client,
    });
    const groups = await readGroupsFromAccessToken(accessToken, region, pool, { expectedSubject: id.sub, expectedClientId: client });
    const verifiedAccessClaims = decodeJwt(accessToken);
    headers.set(SESSION_HEADERS.user, typeof verifiedAccessClaims.username === 'string' ? verifiedAccessClaims.username : id.username ?? id.sub);
    headers.set(SESSION_HEADERS.subject, id.sub);
    headers.set(SESSION_HEADERS.email, id.email ?? '');
    headers.set(SESSION_HEADERS.role, roleFromGroups(groups));
    headers.set(SESSION_HEADERS.authMethod, 'alb');
    return NextResponse.next({ request: { headers } });
  } catch (e) {
    console.error('[auth] identity verification failed', e instanceof Error ? e.message : 'unknown verification error');
    return deny(req, 'Identity verification failed');
  }
}

function deny(req: NextRequest, message: string) {
  console.warn(`[auth] denied ${req.method} ${req.nextUrl.pathname}: ${message} (oidc-data=${req.headers.has('x-amzn-oidc-data')}, access-token=${req.headers.has('x-amzn-oidc-accesstoken')})`);
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: message, code: 'unauthorized' }, { status: 401 });
  }
  return new NextResponse(`<!doctype html><title>Unauthorized</title><body style="font-family:system-ui;padding:2rem"><h1>401</h1><p>${message}</p><p><a href="/api/logout">Sign out and sign in again</a></p></body>`, {
    status: 401,
    headers: { 'content-type': 'text/html' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json).*)'],
};
