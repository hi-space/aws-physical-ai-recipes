import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

/** Retains the deployment's public logout path; origin is server configured. */
export async function GET(req: NextRequest) {
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
