import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/server/aws/clients', () => ({ cognito: () => ({ send: mocks.send }) }));
const key = 'k'.repeat(48);
beforeEach(() => { Object.assign(process.env, { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'us-east-1_p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://alb.example.com', AWS_REGION: 'us-east-1' }); mocks.send.mockReset(); mocks.send.mockResolvedValue({}); });

describe('GET /api/logout (cognito mode)', () => {
  it('revokes the refresh token, clears the cookie and redirects to /login', async () => {
    const { sealAuthCookie } = await import('@/server/auth/cognito-session');
    const sealed = await sealAuthCookie({ at: 'A', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) + 3600 }, key);
    const { GET } = await import('./route');
    const res = await GET(new NextRequest('http://alb.example.com/api/logout', { headers: { cookie: `pai-auth=${sealed}` } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://alb.example.com/login');
    expect(res.headers.get('set-cookie')).toMatch(/^pai-auth=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({ ClientId: 'c', Token: 'R' });
  });
});
