import type { Session } from './auth/session';
import { getRepo } from './store/repo';

/** Record a mutation. Failures are logged, never surfaced to the caller. */
export async function audit(s: Session, action: string, target: string | undefined, result: 'ok' | 'error', message?: string): Promise<void> {
  try {
    await getRepo().audit({ ts: new Date().toISOString(), actor: s.user, role: s.role, action, target, result, message: message?.slice(0, 500) });
  } catch (e) {
    console.error('audit write failed', e);
  }
}
