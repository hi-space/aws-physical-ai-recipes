import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RespondToAuthChallengeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '@/server/aws/clients';
import { assertSameOrigin } from '@/server/auth/request-policy';
import { cognitoSessionEnv } from '@/server/auth/cognito-session';
import { issueSessionResponse, LOGIN_FAILED } from '@/server/auth/cognito-login';
import { HttpError } from '@/server/errors';

export const dynamic = 'force-dynamic';

const body = z.object({ username: z.string().min(1).max(128), session: z.string().min(1), newPassword: z.string().min(1).max(256) });

/** Completes the NEW_PASSWORD_REQUIRED challenge; the new password is never logged or echoed. */
export async function POST(req: NextRequest) {
  try {
    const env = cognitoSessionEnv();
    assertSameOrigin(req, env.origin);
    const parsed = body.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(400, 'username, session and newPassword are required', 'bad_request');
    const out = await cognito()
      .send(new RespondToAuthChallengeCommand({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: env.appClientId,
        Session: parsed.data.session,
        ChallengeResponses: { USERNAME: parsed.data.username, NEW_PASSWORD: parsed.data.newPassword },
      }))
      .catch(() => { throw new HttpError(401, LOGIN_FAILED, 'login_failed'); });
    if (out.ChallengeName) throw new HttpError(401, LOGIN_FAILED, 'login_failed');
    return await issueSessionResponse(out.AuthenticationResult ?? {}, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: e instanceof HttpError ? e.code : 'internal' }, { status });
  }
}
