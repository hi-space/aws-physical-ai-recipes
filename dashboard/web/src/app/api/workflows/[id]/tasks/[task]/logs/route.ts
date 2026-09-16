import { q, qInt, route, sse } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { listPods, podLogs, streamPodLogs } from '@/server/k8s/resources';
import { podLogsFromCloudWatch } from '@/server/aws/logs';
import { notFound } from '@/server/errors';
import { TERMINAL_TASK } from '@/server/store/types';
import { LABEL_TASK, LABEL_WF } from '@/server/workflow/compile';
export const dynamic = 'force-dynamic';

/**
 * Logs for one task. Live pods stream from the Kubernetes API (SSE when follow=1);
 * finished/deleted pods fall back to the Fluent Bit streams in CloudWatch.
 */
export const GET = route<{ id: string; task: string }>('viewer', async ({ params, url, req }) => {
  const repo = getRepo();
  const wf = await repo.getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const task = (await repo.listTasks(params.id)).find((t) => t.name === params.task);
  if (!task?.jobName) return { source: 'none', pods: [], lines: [] };
  const selector = task.workloadKind === 'JobSet'
    ? `${LABEL_WF}=${wf.id},${LABEL_TASK}=${task.name},pai.aws/attempt=${task.attempts}`
    : `job-name=${task.jobName}`;
  const pods = await listPods(wf.namespace, selector);
  const wanted = q(url, 'pod');
  if (wanted && !pods.some((pod) => pod.metadata.name === wanted)) throw notFound('task pod');
  const pod = wanted ? pods.find((p) => p.metadata.name === wanted) : pods.sort((a, b) => (b.status?.startTime ?? '').localeCompare(a.status?.startTime ?? ''))[0];
  const podNames = pods.map((p) => ({ name: p.metadata.name, phase: p.status?.phase, node: p.spec.nodeName, index: p.metadata.annotations?.['batch.kubernetes.io/job-completion-index'] }));
  const tail = Math.max(1, Math.min(10000, qInt(url, 'tail', 1000)));

  if (!pod) {
    // Pod gone (TTL / deleted) — CloudWatch by pod-name prefix.
    const prefix = task.workloadKind === 'JobSet' ? `${task.jobName}-${task.name}-` : `${task.jobName}-`;
    const cw = await podLogsFromCloudWatch(wf.namespace, prefix, tail);
    return { source: 'cloudwatch', pods: podNames, lines: cw.map((l) => `${new Date(l.ts).toISOString()} ${l.message}`) };
  }
  const phase = pod.status?.phase;
  const init = pod.status?.initContainerStatuses ?? [];
  const preparing = init.find((container) => (container.state?.terminated?.exitCode ?? 0) !== 0) ?? init.find((container) => container.state?.running);
  const container = preparing?.name ?? 'main';
  if (phase === 'Pending' && !preparing) return { source: 'kubernetes', pods: podNames, pod: pod.metadata.name, lines: [`작업 환경을 준비하는 중입니다: ${pod.status?.conditions?.map((condition) => condition.message).filter(Boolean).join('; ') || '스케줄링 또는 이미지 준비 대기'}`] };

  if (q(url, 'follow') === '1' && phase === 'Running' && !TERMINAL_TASK.has(task.phase)) {
    const stream = await streamPodLogs(wf.namespace, pod.metadata.name, { container, tailLines: tail, signal: req.signal });
    const reader = stream.getReader();
    const dec = new TextDecoder();
    async function* gen() {
      yield { event: 'meta', data: { pod: pod!.metadata.name, pods: podNames } };
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          if (parts.length) yield { data: parts };
        }
        buf += dec.decode();
        if (buf) yield { data: [buf] };
        yield { event: 'end', data: {} };
      } finally { await reader.cancel().catch(() => undefined); }
    }
    return sse(gen(), req.signal, () => reader.cancel());
  }
  try {
    const text = await podLogs(wf.namespace, pod.metadata.name, { container, tailLines: tail });
    return { source: 'kubernetes', pods: podNames, pod: pod.metadata.name, phase, container, lines: [...(preparing ? [`준비 단계 로그: ${container}`] : []), ...text.split('\n').filter((line) => line.length)] };
  } catch (e) {
    const cw = await podLogsFromCloudWatch(wf.namespace, pod.metadata.name, tail).catch(() => []);
    return { source: 'cloudwatch', pods: podNames, pod: pod.metadata.name, phase, lines: cw.length ? cw.map((l) => `${new Date(l.ts).toISOString()} ${l.message}`) : [`no logs available: ${(e as Error).message}`] };
  }
});
