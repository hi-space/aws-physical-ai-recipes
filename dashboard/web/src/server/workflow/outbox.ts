import type { Workflow } from '../store/types';
import { TERMINAL_WF } from '../store/types';
import type { ControllerDeps } from './ports';
import type { LeaseGuard } from './lease';

/** At-least-once delivery; external adapters deduplicate using idempotencyKey. */
export async function deliverOutbox(wf: Workflow, deps: ControllerDeps, guard: LeaseGuard): Promise<Workflow> {
  for (const entry of await deps.repo.listOutbox(wf.id)) {
    if (entry.deliveredAt || entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > deps.now().getTime()) continue;
    const context = {
      idempotencyKey: entry.idempotencyKey,
      signal: guard.signal,
      lease: guard.lease,
    };
    try {
      await guard.check();
      if (entry.kind === 'complete') {
        if (!deps.completeWorkflow || !TERMINAL_WF.has(wf.status)) continue;
        await deps.completeWorkflow(wf, context);
        wf = (await deps.repo.getWorkflow(wf.id)) ?? wf;
      } else {
        const settings = await deps.repo.getSettings();
        if (settings.notifyOn.includes(wf.status as 'SUCCEEDED' | 'FAILED' | 'CANCELLED')) await deps.notify(`[Physical AI] workflow ${wf.name} ${wf.status}`, `Workflow ${wf.name} (${wf.id}) finished with status ${wf.status}.\n${wf.message ?? ''}`);
      }
      await deps.repo.putOutbox(wf.id, {
        ...entry,
        deliveredAt: deps.now().toISOString(),
        attempts: entry.attempts + 1,
        lastError: undefined,
        nextAttemptAt: undefined
      }, guard.lease);
    } catch (e) {
      guard.signal.throwIfAborted();
      const attempts = entry.attempts + 1;
      await deps.repo.putOutbox(wf.id, {
        ...entry,
        attempts,
        lastError: String(e),
        nextAttemptAt: new Date(deps.now().getTime() + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 9))).toISOString()
      }, guard.lease);
    }
  }
  return wf;
}
