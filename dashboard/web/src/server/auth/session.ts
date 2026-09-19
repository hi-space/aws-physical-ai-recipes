import { forbidden, unauthorized } from '../errors';
import { hasRole, isRole, type Role } from './rbac';

export interface Session {
  user: string;
  subject?: string;
  email: string;
  role: Role;
  authMethod?: 'alb' | 'cognito' | 'token';
  tokenProjectId?: string;
  scopes?: string[];
  tokenId?: string;
}

/** Header names set by proxy.ts after verifying the ALB identity headers. */
export const SESSION_HEADERS = {
  user: 'x-pai-user',
  subject: 'x-pai-subject',
  email: 'x-pai-email',
  role: 'x-pai-role',
  authMethod: 'x-pai-auth-method',
  tokenProjectId: 'x-pai-token-project',
  scopes: 'x-pai-token-scopes',
  tokenId: 'x-pai-token-id',
} as const;

export function sessionFromHeaders(h: Headers): Session {
  const user = h.get(SESSION_HEADERS.user);
  const role = h.get(SESSION_HEADERS.role);
  if (!user || !isRole(role)) throw unauthorized();
  const raw = h.get(SESSION_HEADERS.authMethod);
  const authMethod = raw === 'token' ? 'token' : raw === 'cognito' ? 'cognito' : 'alb';
  return {
    user, subject: h.get(SESSION_HEADERS.subject) ?? user, email: h.get(SESSION_HEADERS.email) ?? '', role, authMethod,
    ...(authMethod === 'token' ? { tokenProjectId: h.get(SESSION_HEADERS.tokenProjectId) ?? undefined, scopes: (h.get(SESSION_HEADERS.scopes) ?? '').split(',').filter(Boolean), tokenId: h.get(SESSION_HEADERS.tokenId) ?? undefined } : {}),
  };
}

export function requireRole(s: Session, required: Role): void {
  if (!hasRole(s.role, required)) throw forbidden(`Requires ${required} role`);
}

/** Destructive actions on user-owned resources require the owner or an admin. */
export function assertOwner(s: Session, owner: string | undefined, what = 'resource'): void {
  if (s.role === 'admin') return;
  if (!owner || owner !== s.user) throw forbidden(`Only the owner of this ${what} (${owner ?? 'unknown'}) or an admin can do that`);
}
