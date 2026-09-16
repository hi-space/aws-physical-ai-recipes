import { forbidden, unauthorized } from '../errors';
import { hasRole, isRole, type Role } from './rbac';

export interface Session {
  user: string;
  email: string;
  role: Role;
}

/** Header names set by proxy.ts after verifying the ALB identity headers. */
export const SESSION_HEADERS = {
  user: 'x-pai-user',
  email: 'x-pai-email',
  role: 'x-pai-role',
} as const;

export function sessionFromHeaders(h: Headers): Session {
  const user = h.get(SESSION_HEADERS.user);
  const role = h.get(SESSION_HEADERS.role);
  if (!user || !isRole(role)) throw unauthorized();
  return { user, email: h.get(SESSION_HEADERS.email) ?? '', role };
}

export function requireRole(s: Session, required: Role): void {
  if (!hasRole(s.role, required)) throw forbidden(`Requires ${required} role`);
}
