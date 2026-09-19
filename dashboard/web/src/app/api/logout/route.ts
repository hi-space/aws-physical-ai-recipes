import { NextResponse, type NextRequest } from 'next/server';
import { RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '@/server/aws/clients';
import { AUTH_COOKIE, clearAuthCookieHeader, cognitoSessionEnv, openAuthCookie } from '@/server/auth/cognito-session';
export const dynamic = 'force-dynamic';

/** Retains the deployment's public logout path; origin is server configured. */
export async function GET(req: NextRequest) {
  if (process.env.AUTH_MODE === 'cognito') {
    const env = cognitoSessionEnv();
    const cookie = await openAuthCookie(req.cookies.get(AUTH_COOKIE)?.value, env.signingKey);
    // Best-effort revoke; a failed revoke must not block sign-out. Never log the token.
    if (cookie) await cognito().send(new RevokeTokenCommand({ ClientId: env.appClientId, Token: cookie.rt })).catch((e) => console.warn('[auth] revoke failed', e instanceof Error ? e.message : e));
    const response = NextResponse.redirect(`${env.origin}/login`, 302);
    response.headers.append('set-cookie', clearAuthCookieHeader(env.origin));
    return response;
  }
  const clientId = process.env.COGNITO_CLIENT_ID;
  // Hosted UI domain (e.g. <prefix>.auth.<region>.amazoncognito.com) comes from the deployment, never a naming convention.
  const cognitoDomain = process.env.COGNITO_DOMAIN;
  const origin = process.env.DASHBOARD_ORIGIN ?? process.env.APP_ORIGIN;
  if (!origin) return new NextResponse('Logout is not configured', { status: 503 });
  const target = clientId && cognitoDomain ? `https://${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(origin + '/')}` : origin + '/';
  const response = NextResponse.redirect(target, 302);
  const cookieNames = new Set(['AWSELBAuthSessionCookie', ...Array.from({ length: 8 }, (_, index) => `AWSELBAuthSessionCookie-${index}`)]);
  for (const cookie of req.cookies.getAll()) if (cookie.name.startsWith('AWSELBAuthSessionCookie')) cookieNames.add(cookie.name);
  for (const name of cookieNames) response.cookies.set(name, '', { maxAge: 0, path: '/', secure: true, httpOnly: true });
  return response;
}
