import { NextResponse, type NextRequest } from 'next/server';
import { readGroupsFromAccessToken, verifyAlbOidcData } from '@/server/auth/alb-jwt';
import { roleFromGroups } from '@/server/auth/rbac';
import { SESSION_HEADERS } from '@/server/auth/session';
import { decodeJwt } from 'jose';
import { verifyApiToken } from '@/server/auth/api-tokens';
import {
  AUTH_COOKIE,
  authCookieHeader,
  clearAuthCookieHeader,
  cognitoSessionEnv,
  openAuthCookie,
  refreshAccess,
  sealAuthCookie,
  verifyAccessToken,
  type VerifiedAccess,
} from '@/server/auth/cognito-session';

const PUBLIC_PATHS = ['/api/health', '/api/logout', '/login', '/api/auth/login', '/api/auth/challenge'];

/**
 * Next.js 16 request boundary. Turns the ALB's Cognito identity headers into
 * trusted x-pai-* headers for Route Handlers and Server Components. In dev mode
 * (AUTH_MODE=dev) every request is an admin.
 */
export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const headers = new Headers(req.headers);
  // Never trust client-supplied session headers, nor a client-supplied copy of
  // the bare-layout flag — both are set only by this middleware, below.
  for (const h of Object.values(SESSION_HEADERS)) headers.delete(h);
  headers.delete('x-pai-bare-layout');

  if (pathname === '/login') {
    // Render the login page without the app chrome: the sidebar's own /api/me
    // fetch would 401-redirect in a loop. This trusted request header tells the
    // (server-component) root layout to drop the sidebar; it is scrubbed above so
    // it can only ever originate here.
    headers.set('x-pai-bare-layout', '1');
    return NextResponse.next({ request: { headers } });
  }
  if (PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith('/_next/')) return NextResponse.next({ request: { headers } });
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

  if (authMode === 'cognito') {
    const env = cognitoSessionEnv();
    // The cookie envelope is app-signed but deliberately opens even when expired
    // (openAuthCookie tolerates the clock), so it proves nothing on its own: the
    // access token is always re-verified against the user pool before we trust it.
    const cookie = await openAuthCookie(req.cookies.get(AUTH_COOKIE)?.value, env.signingKey);
    if (!cookie) return denyCognito(req, env.origin);
    let at = cookie.at, exp = cookie.exp, setCookie: string | undefined;
    let identity: VerifiedAccess;
    try {
      identity = await verifyAccessToken(at, env);
    } catch {
      // Access token expired/invalid: mint a fresh one from the refresh token,
      // re-verify it, and re-seal the cookie for the refresh token's lifetime.
      try {
        const fresh = await refreshAccess(cookie.rt, env);
        at = fresh.at; exp = fresh.exp;
        identity = await verifyAccessToken(at, env);
        setCookie = authCookieHeader(
          await sealAuthCookie({ at, rt: cookie.rt, sub: identity.sub, exp }, env.signingKey),
          env.origin,
          Math.max(60, exp - Math.floor(Date.now() / 1000) + 30 * 86400),
        );
      } catch (e) {
        console.warn('[auth] cognito refresh failed', e instanceof Error ? e.message : e);
        return denyCognito(req, env.origin, true);
      }
    }
    if (identity.sub !== cookie.sub) return denyCognito(req, env.origin, true);
    headers.set(SESSION_HEADERS.user, identity.username);
    headers.set(SESSION_HEADERS.subject, identity.sub);
    headers.set(SESSION_HEADERS.email, identity.email);
    headers.set(SESSION_HEADERS.role, roleFromGroups(identity.groups));
    headers.set(SESSION_HEADERS.authMethod, 'cognito');
    const res = NextResponse.next({ request: { headers } });
    if (setCookie) res.headers.append('set-cookie', setCookie);
    return res;
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

/**
 * Deny an AUTH_MODE=cognito request: 401 JSON for /api/*, otherwise a 302 to
 * the in-app login page carrying the original path as ?next=. When `clear` is
 * set the browser's session cookie is cleared, so a bad or unrefreshable cookie
 * never lingers to be retried.
 */
function denyCognito(req: NextRequest, origin: string, clear = false) {
  const { pathname, search } = req.nextUrl;
  let res: NextResponse;
  if (pathname.startsWith('/api/')) {
    // The client's api() reads this header and sends the browser to the login
    // page; a bare 401 body alone can't drive navigation from a fetch.
    res = NextResponse.json({ error: 'Sign in required', code: 'unauthorized' }, { status: 401 });
    res.headers.set('x-pai-login', '/login');
  } else {
    res = NextResponse.redirect(`${origin}/login?next=${encodeURIComponent(pathname + search)}`, { status: 302 });
  }
  if (clear) res.headers.append('set-cookie', clearAuthCookieHeader(origin));
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json).*)'],
};
