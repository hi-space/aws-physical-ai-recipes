import { authorizeCookie } from './auth';
import type { AuthOptions, GatewaySession } from './types';

/** Bounds already-open streams, including requests still waiting for the upstream handshake. */
export function guardConnection(
  session: GatewaySession,
  cookie: string | undefined,
  host: string,
  controller: AbortController,
  options: AuthOptions & { recheckMs?: number },
): () => void {
  let checking = false;
  const now = options.now ?? Date.now;
  let deadline: ReturnType<typeof setTimeout>;
  let validationTimeout: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    const remaining = Date.parse(session.expiresAt) - now();
    if (remaining <= 0) { queueMicrotask(() => controller.abort()); return; }
    deadline = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    deadline.unref();
  };
  armDeadline();
  const interval = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    validationTimeout = setTimeout(() => controller.abort(), 5_000);
    validationTimeout.unref();
    try { await authorizeCookie(cookie, host, options); }
    catch { controller.abort(); }
    finally { clearTimeout(validationTimeout); checking = false; }
  }, Math.max(10, Math.min(options.recheckMs ?? 5_000, 5_000)));
  interval.unref();
  const cleanup = () => { clearTimeout(deadline); clearTimeout(validationTimeout); clearInterval(interval); };
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return () => { cleanup(); controller.signal.removeEventListener('abort', cleanup); };
}
