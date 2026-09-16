import type { ControllerDeps } from './ports';
import type { RunLease } from '../store/types';
export interface LeaseGuard {
  lease: RunLease;
  signal: AbortSignal;
  check(): Promise<void>;
}
/** Every invocation has a unique owner. A failed renewal aborts IO and fences every durable write. */
export async function withRunLease<T>(runId: string, deps: ControllerDeps, action: (guard: LeaseGuard) => Promise<T>): Promise<T | undefined> {
  const seconds = Math.max(1, deps.leaseSeconds ?? 30);
  const lease = await deps.repo.acquireRunLease(runId, seconds);
  if (!lease) return undefined;
  const abort = new AbortController();
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || abort.signal.aborted) return;
    renewing = true;
    void deps.repo.renewRunLease(lease, seconds).then(ok => {
      if (!ok) abort.abort(new Error('run lease lost'));
    }, e => abort.abort(e)).finally(() => {
      renewing = false;
    });
  }, Math.max(100, seconds * 1000 / 3));
  timer.unref?.();
  const guard: LeaseGuard = {
    lease,
    signal: abort.signal,
    async check() {
      abort.signal.throwIfAborted();
      if (!(await deps.repo.runLeaseValid(lease))) {
        abort.abort(new Error('run lease lost'));
        abort.signal.throwIfAborted();
      }
    }
  };
  try {
    return await action(guard);
  } finally {
    clearInterval(timer);
    abort.abort();
    await deps.repo.releaseRunLease(lease);
  }
}
