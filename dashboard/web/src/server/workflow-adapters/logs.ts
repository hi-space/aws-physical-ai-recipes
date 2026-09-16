import { createLogCollector } from '../logs/collector';
import type { Repo } from '../store/repo';
import type { Workflow } from '../store/types';
import type { ControllerDeps } from '../workflow/ports';
import { injectedLogSecrets } from './log-secrets';

const collectors = new WeakMap<Repo, NonNullable<ControllerDeps['logs']>>();
export function workflowLogHooks(repo: Repo): NonNullable<ControllerDeps['logs']> {
  const existing = collectors.get(repo);
  if (existing) return existing;
  const collector = createLogCollector({ repo, secrets: injectedLogSecrets });
  async function health(workflow: Workflow, incomplete: boolean, reason: string) {
    const pk = `WF#${workflow.id}`, sk = 'LOG_CAPTURE_STATUS', now = Date.now();
    const old = await repo.kv.get(pk, sk);
    const warn = incomplete && now - Number(old?.lastWarningAt ?? 0) >= 60_000;
    if (old?.state !== (incomplete ? 'incomplete' : 'observing') || warn) await repo.kv.put({
      pk, sk, state: incomplete ? 'incomplete' : 'observing', coverage: 'captured-only', checkedAt: new Date(now).toISOString(),
      lastWarningAt: warn ? now : old?.lastWarningAt ?? 0, ...(incomplete ? { reason } : {}),
    });
    if (warn) await repo.appendEvent({
      workflowId: workflow.id, ts: new Date(now).toISOString(), type: 'warning', source: 'controller', reason,
      message: '로그 보관을 완료하지 못한 구간이 있습니다. 실행 결과와 별도로 보관된 로그의 수집 범위를 확인하세요.',
    });
  }
  const hooks: NonNullable<ControllerDeps['logs']> = {
    reconcile: async workflow => {
      try { await collector.reconcile(workflow); await health(workflow, false, ''); }
      catch { await health(workflow, true, 'LogCaptureIncomplete'); }
    },
    drain: async (workflow, taskNames, attempt) => {
      let complete = true;
      try {
        complete = (await collector.settleCompleted(workflow.id, { taskNames, attempt, timeoutMs: 5000 })).settled;
        const results = await Promise.allSettled(taskNames.map(taskName =>
          collector.drain(workflow.id, { taskName, attempt, timeoutMs: 5000 })));
        complete = complete && results.every(result => result.status === 'fulfilled' && result.value.drained);
      } catch { complete = false; }
      // Observability failure must not keep GPU processes alive indefinitely during cancellation.
      if (!complete) await health(workflow, true, 'LogDrainIncomplete');
    },
  };
  collectors.set(repo, hooks);
  return hooks;
}
