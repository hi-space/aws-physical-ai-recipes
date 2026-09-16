import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

/**
 * Clears the ALB authentication session cookies and sends the browser to the
 * Cognito hosted-UI logout, which then redirects back to the dashboard root
 * (registered as a logout URL on the app client). Public path in proxy.ts.
 */
export async function GET(req: NextRequest) {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const account = process.env.ACCOUNT_ID ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID;
  const origin = `${req.headers.get('x-forwarded-proto') ?? 'https'}://${req.headers.get('host')}`;
  const target = clientId ? `https://physical-ai-${account}.auth.${region}.amazoncognito.com/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(origin + '/')}` : origin + '/';
  const res = NextResponse.redirect(target, 302);
  for (let i = 0; i < 4; i++) res.cookies.set(`AWSELBAuthSessionCookie-${i}`, '', { maxAge: 0, path: '/', secure: true });
  return res;
}
