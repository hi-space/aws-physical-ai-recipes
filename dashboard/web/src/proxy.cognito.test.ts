import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), refresh: vi.fn() }));
vi.mock('@/server/auth/cognito-session', async (orig) => ({ ...(await orig<typeof import('@/server/auth/cognito-session')>()), verifyAccessToken: mocks.verify, refreshAccess: mocks.refresh }));
import { sealAuthCookie, clearAuthCookieHeader } from '@/server/auth/cognito-session';
import proxy from './proxy';
const key = 'k'.repeat(48);
beforeEach(() => {
  Object.assign(process.env, { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'us-east-1_p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://alb.example.com', AWS_REGION: 'us-east-1' });
  mocks.verify.mockReset(); mocks.refresh.mockReset();
});
const req = (path: string, cookie?: string) => new NextRequest(`http://alb.example.com${path}`, { headers: cookie ? { cookie: `pai-auth=${cookie}` } : {} });

describe('proxy AUTH_MODE=cognito', () => {
  it('redirects pages without a cookie to /login?next=… and answers 401 JSON for APIs', async () => {
    const page = await proxy(req('/workflows'));
    expect(page.status).toBe(302); expect(page.headers.get('location')).toBe('http://alb.example.com/login?next=%2Fworkflows');
    const api = await proxy(req('/api/workflows'));
    expect(api.status).toBe(401);
  });
  it('lets /login and the auth endpoints through without a cookie', async () => {
    for (const p of ['/login', '/api/auth/login', '/api/auth/challenge', '/api/health']) expect((await proxy(req(p))).status).toBe(200);
  });
  it('flags /login for the bare (sidebar-less) layout', async () => {
    const res = await proxy(req('/login'));
    expect(res.headers.get('x-middleware-request-x-pai-bare-layout')).toBe('1');
  });
  it('cannot let a client forge the bare-layout flag', async () => {
    const res = await proxy(new NextRequest('http://alb.example.com/login', { headers: { 'x-pai-bare-layout': 'evil' } }));
    expect(res.headers.get('x-middleware-request-x-pai-bare-layout')).toBe('1');
  });
  it('scrubs a client-supplied bare-layout flag on non-login paths', async () => {
    mocks.verify.mockResolvedValue({ sub: 's1', username: 'alice', email: 'a@x', groups: ['researchers'], exp: Math.floor(Date.now() / 1000) + 600 });
    const cookie = await sealAuthCookie({ at: 'A', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) + 600 }, key);
    const res = await proxy(new NextRequest('http://alb.example.com/workflows', { headers: { cookie: `pai-auth=${cookie}`, 'x-pai-bare-layout': '1' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-x-pai-bare-layout')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-pai-role')).toBe('researcher');
  });
  it('carries x-pai-login on the API 401 so the client can redirect to /login', async () => {
    const api = await proxy(req('/api/workflows'));
    expect(api.status).toBe(401);
    expect(api.headers.get('x-pai-login')).toBe('/login');
  });
  it('turns a valid cookie into x-pai-* headers with authMethod cognito', async () => {
    mocks.verify.mockResolvedValue({ sub: 's1', username: 'alice', email: 'a@x', groups: ['researchers'], exp: Math.floor(Date.now() / 1000) + 600 });
    const cookie = await sealAuthCookie({ at: 'A', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) + 600 }, key);
    const res = await proxy(req('/api/me', cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-x-pai-role')).toBe('researcher');
    expect(res.headers.get('x-middleware-request-x-pai-auth-method')).toBe('cognito');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('refreshes an expired access token and re-seals the cookie', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('"exp" claim timestamp check failed')).mockResolvedValueOnce({ sub: 's1', username: 'alice', email: '', groups: [], exp: Math.floor(Date.now() / 1000) + 3600 });
    mocks.refresh.mockResolvedValue({ at: 'NEW', exp: Math.floor(Date.now() / 1000) + 3600 });
    const cookie = await sealAuthCookie({ at: 'OLD', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) - 5 }, key);
    const res = await proxy(req('/api/me', cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^pai-auth=.+HttpOnly; SameSite=Lax/);
    expect(mocks.refresh).toHaveBeenCalledWith('R', expect.anything());
  });
  it('denies and clears the cookie when an expired token cannot be refreshed', async () => {
    mocks.verify.mockRejectedValue(new Error('"exp" claim timestamp check failed'));
    mocks.refresh.mockRejectedValue(new Error('NotAuthorizedException: refresh token revoked'));
    const cookie = await sealAuthCookie({ at: 'OLD', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) - 5 }, key);
    const res = await proxy(req('/api/me', cookie));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(clearAuthCookieHeader('http://alb.example.com'));
  });
  it('rejects a forged cookie', async () => {
    const res = await proxy(req('/api/me', 'not.a.jwt'));
    expect(res.status).toBe(401);
  });
});
