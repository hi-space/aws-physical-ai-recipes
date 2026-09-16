import { NextResponse, type NextRequest } from 'next/server';
import { readGroupsFromAccessToken, verifyAlbOidcData } from '@/server/auth/alb-jwt';
import { roleFromGroups } from '@/server/auth/rbac';
import { SESSION_HEADERS } from '@/server/auth/session';

const PUBLIC_PATHS = ['/api/health'];

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

  const authMode = process.env.AUTH_MODE ?? 'alb';
  if (authMode === 'dev') {
    headers.set(SESSION_HEADERS.user, process.env.DEV_USER ?? 'dev');
    headers.set(SESSION_HEADERS.email, 'dev@local');
    headers.set(SESSION_HEADERS.role, process.env.DEV_ROLE ?? 'admin');
    return NextResponse.next({ request: { headers } });
  }

  const oidcData = req.headers.get('x-amzn-oidc-data');
  const accessToken = req.headers.get('x-amzn-oidc-accesstoken') ?? '';
  if (!oidcData) return deny(req, 'Missing identity headers (request did not come through the ALB)');
  try {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const id = await verifyAlbOidcData(oidcData, region, { expectedSigner: process.env.ALB_ARN ?? '' });
    const groups = await readGroupsFromAccessToken(accessToken, region, process.env.COGNITO_USER_POOL_ID ?? '');
    headers.set(SESSION_HEADERS.user, id.username ?? id.email ?? id.sub);
    headers.set(SESSION_HEADERS.email, id.email ?? '');
    headers.set(SESSION_HEADERS.role, roleFromGroups(groups));
    return NextResponse.next({ request: { headers } });
  } catch (e) {
    return deny(req, `Identity verification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function deny(req: NextRequest, message: string) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: message, code: 'unauthorized' }, { status: 401 });
  }
  return new NextResponse(`<!doctype html><title>Unauthorized</title><body style="font-family:system-ui;padding:2rem"><h1>401</h1><p>${message}</p></body>`, {
    status: 401,
    headers: { 'content-type': 'text/html' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json).*)'],
};
