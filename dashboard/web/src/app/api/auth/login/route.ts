import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '@/server/aws/clients';
import { assertSameOrigin } from '@/server/auth/request-policy';
import { cognitoSessionEnv } from '@/server/auth/cognito-session';
import { issueSessionResponse, LOGIN_FAILED } from '@/server/auth/cognito-login';
import { HttpError } from '@/server/errors';

export const dynamic = 'force-dynamic';

const body = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) });

export async function POST(req: NextRequest) {
  try {
    const env = cognitoSessionEnv();
    assertSameOrigin(req, env.origin);
    const parsed = body.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(400, 'username and password are required', 'bad_request');
    // Any Cognito auth error (NotAuthorized, UserNotFound, …) collapses to one
    // generic 401 so the response never distinguishes a bad password from an
    // unknown user, and the caller's message/name is never logged.
    const out = await cognito()
      .send(new InitiateAuthCommand({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: env.appClientId, AuthParameters: { USERNAME: parsed.data.username, PASSWORD: parsed.data.password } }))
      .catch(() => { throw new HttpError(401, LOGIN_FAILED, 'login_failed'); });
    if (out.ChallengeName === 'NEW_PASSWORD_REQUIRED') return NextResponse.json({ challenge: 'NEW_PASSWORD_REQUIRED', session: out.Session });
    if (out.ChallengeName) throw new HttpError(401, LOGIN_FAILED, 'login_failed');
    return await issueSessionResponse(out.AuthenticationResult ?? {}, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: e instanceof HttpError ? e.code : 'internal' }, { status });
  }
}
