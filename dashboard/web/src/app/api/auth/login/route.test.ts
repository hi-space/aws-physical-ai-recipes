import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), audit: vi.fn() }));
vi.mock('@/server/aws/clients', () => ({ cognito: () => ({ send: mocks.send }) }));
vi.mock('@/server/auth/cognito-session', async (orig) => ({ ...(await orig<typeof import('@/server/auth/cognito-session')>()), verifyAccessToken: mocks.verify }));
vi.mock('@/server/audit', () => ({ audit: mocks.audit }));
const key = 'k'.repeat(48);
beforeEach(() => { Object.assign(process.env, { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'us-east-1_p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://alb.example.com', AWS_REGION: 'us-east-1' }); mocks.send.mockReset(); mocks.verify.mockReset(); });
const post = (body: unknown, origin = 'http://alb.example.com') => new Request('http://alb.example.com/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });

describe('POST /api/auth/login', () => {
  it('signs in with USER_PASSWORD_AUTH and sets the auth cookie', async () => {
    mocks.send.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R', ExpiresIn: 3600 } });
    mocks.verify.mockResolvedValueOnce({ sub: 's1', username: 'alice', email: '', groups: ['admins'], exp: Math.floor(Date.now() / 1000) + 3600 });
    const { POST } = await import('./route');
    const res = await POST(post({ username: 'alice', password: 'pw' }) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^pai-auth=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'c', AuthParameters: { USERNAME: 'alice', PASSWORD: 'pw' } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ user: 'alice', role: 'admin' }), 'auth.login', 'alice', 'ok');
  });
  it('returns the NEW_PASSWORD_REQUIRED challenge session without a cookie', async () => {
    mocks.send.mockResolvedValueOnce({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'S' });
    const { POST } = await import('./route');
    const res = await POST(post({ username: 'alice', password: 'tmp' }) as never);
    expect(await res.json()).toEqual({ challenge: 'NEW_PASSWORD_REQUIRED', session: 'S' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('answers 401 with one generic message for NotAuthorized and UserNotFound alike', async () => {
    const { POST } = await import('./route');
    for (const name of ['NotAuthorizedException', 'UserNotFoundException']) {
      mocks.send.mockRejectedValueOnce(Object.assign(new Error('x'), { name }));
      const res = await POST(post({ username: 'alice', password: 'pw' }) as never);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('login_failed');
    }
  });
  it('rejects cross-origin posts', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ username: 'a', password: 'b' }, 'http://evil.example') as never)).status).toBe(403);
  });
});
