import type { Job, Pod } from '../k8s/resources';
import type { TaskPhase } from '../store/types';
interface Derived {
  phase: TaskPhase;
  message?: string;
  startedAt?: string;
}

/** Translate Job + Pods (+ Kueue) into a task phase. */
export function deriveTaskPhase(job: Job | null, pods: Pod[], queue: 'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown', replicas: number): Derived {
  if (!job) return {
    phase: 'FAILED',
    message: 'Kubernetes Job not found (deleted outside the dashboard?)'
  };
  const st = job.status ?? {};
  const completions = job.spec.completions ?? 1;
  const failedCond = st.conditions?.find(c => c.type === 'Failed' && c.status === 'True');
  const completeCond = st.conditions?.find(c => (c.type === 'Complete' || c.type === 'SuccessCriteriaMet') && c.status === 'True');
  if (completeCond || (st.succeeded ?? 0) >= completions) return {
    phase: 'SUCCEEDED',
    startedAt: st.startTime
  };
  if (failedCond) {
    const lastPod = pods.find(p => p.status?.phase === 'Failed');
    const cs = lastPod?.status?.containerStatuses?.[0]?.state?.terminated;
    const detail = cs ? ` (exit ${cs.exitCode}${cs.reason ? ` ${cs.reason}` : ''})` : '';
    return {
      phase: 'FAILED',
      message: `${failedCond.reason ?? 'Failed'}: ${failedCond.message ?? ''}${detail}`.trim(),
      startedAt: st.startTime
    };
  }
  if (pods.some(p => p.status?.phase === 'Running')) return {
    phase: 'RUNNING',
    startedAt: st.startTime ?? pods.find(p => p.status?.startTime)?.status?.startTime
  };
  if (pods.length) {
    const pend = pods.find(p => p.status?.phase === 'Pending');
    const sched = pend?.status?.conditions?.find(c => c.type === 'PodScheduled' && c.status === 'False');
    const waiting = pend?.status?.containerStatuses?.[0]?.state?.waiting;
    const msg = sched?.message ?? (waiting ? `${waiting.reason ?? ''} ${waiting.message ?? ''}`.trim() : undefined);
    return {
      phase: 'PENDING',
      message: msg ? msg.slice(0, 300) : undefined
    };
  }
  if (job.spec.suspend || queue === 'pending' || queue === 'evicted') return {
    phase: 'QUEUED',
    message: queue === 'evicted' ? 'evicted by Kueue (preempted), waiting for re-admission' : 'waiting for Kueue admission (quota)'
  };
  if ((st.failed ?? 0) > 0 && (st.active ?? 0) === 0 && (job.spec.backoffLimit ?? 0) > 0) return {
    phase: 'PENDING',
    message: `retrying (${st.failed}/${(job.spec.backoffLimit ?? 0) + 1} attempts)`
  };
  return {
    phase: 'PENDING',
    message: replicas > 1 ? 'creating pods' : 'creating pod'
  };
}
