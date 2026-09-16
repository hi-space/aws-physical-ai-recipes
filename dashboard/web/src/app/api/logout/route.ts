import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

/** Retains the deployment's public logout path; origin is server configured. */
export async function GET(req: NextRequest) {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const account = process.env.ACCOUNT_ID ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID;
  const origin = process.env.DASHBOARD_ORIGIN ?? process.env.APP_ORIGIN;
  if (!origin) return new NextResponse('Logout is not configured', { status: 503 });
  const target = clientId ? `https://physical-ai-${account}.auth.${region}.amazoncognito.com/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(origin + '/')}` : origin + '/';
  const response = NextResponse.redirect(target, 302);
  const cookieNames = new Set(['AWSELBAuthSessionCookie', ...Array.from({ length: 8 }, (_, index) => `AWSELBAuthSessionCookie-${index}`)]);
  for (const cookie of req.cookies.getAll()) if (cookie.name.startsWith('AWSELBAuthSessionCookie')) cookieNames.add(cookie.name);
  for (const name of cookieNames) response.cookies.set(name, '', { maxAge: 0, path: '/', secure: true, httpOnly: true });
  return response;
}
