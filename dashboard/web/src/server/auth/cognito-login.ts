import { NextResponse } from 'next/server';
import { audit } from '@/server/audit';
import { HttpError } from '@/server/errors';
import { roleFromGroups } from './rbac';
import { authCookieHeader, cognitoSessionEnv, sealAuthCookie, verifyAccessToken } from './cognito-session';

const REFRESH_DAYS = 30;
const LOGIN_FAILED = '로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.';

/**
 * Turn a Cognito `AuthenticationResult` into a session cookie response, shared
 * by the login and new-password-challenge routes. The access token is
 * re-verified against the user pool JWKS *before* any cookie is set, so a
 * forged or mismatched token never yields a session. Never logs credentials.
 */
export async function issueSessionResponse(
  result: { AccessToken?: string; RefreshToken?: string },
  env = cognitoSessionEnv(),
) {
  if (!result.AccessToken || !result.RefreshToken) throw new HttpError(401, LOGIN_FAILED, 'login_failed');
  const identity = await verifyAccessToken(result.AccessToken, env);
  const role = roleFromGroups(identity.groups);
  const sealed = await sealAuthCookie({ at: result.AccessToken, rt: result.RefreshToken, sub: identity.sub, exp: identity.exp }, env.signingKey);
  const res = NextResponse.json({ ok: true, user: identity.username, role });
  res.headers.append('set-cookie', authCookieHeader(sealed, env.origin, REFRESH_DAYS * 86400));
  await audit(
    { user: identity.username, subject: identity.sub, email: identity.email, role, authMethod: 'cognito' },
    'auth.login',
    identity.username,
    'ok',
  );
  return res;
}

export { LOGIN_FAILED };
