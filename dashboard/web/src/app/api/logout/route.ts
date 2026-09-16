import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

/**
 * Clears the ALB authentication session cookies and sends the browser to the
 * Cognito hosted-UI logout, which then redirects back to the dashboard root
 * (registered as a logout URL on the app client). Public path in proxy.ts.
 *
 * The return origin comes from APP_ORIGIN (set by CDK from the domain name), never
 * from the Host header: the ALB has no host-based rule, so a forged Host would
 * otherwise turn this route into an open redirect.
 */
export async function GET(_req: NextRequest) {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const account = process.env.ACCOUNT_ID ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID;
  const origin = process.env.APP_ORIGIN;
  if (!origin) return new NextResponse('APP_ORIGIN is not configured', { status: 500 });
  const target = clientId ? `https://physical-ai-${account}.auth.${region}.amazoncognito.com/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(origin + '/')}` : origin + '/';
  const res = NextResponse.redirect(target, 302);
  for (let i = 0; i < 4; i++) res.cookies.set(`AWSELBAuthSessionCookie-${i}`, '', { maxAge: 0, path: '/', secure: true });
  return res;
}
