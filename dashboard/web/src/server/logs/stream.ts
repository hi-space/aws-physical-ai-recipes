import { listPods, podLogs, streamPodLogs, type Pod } from '../k8s/resources';
import type { Workflow } from '../store/types';
import { HttpError } from '../errors';
import type { SecretRedactor } from './redaction';
import { LIMITS, type LogLine, type LogTarget } from './types';

const TS = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) ?/;
export const taskSelector = (wf: Workflow, task: string) => `app.kubernetes.io/managed-by=physical-ai-dashboard,pai.aws/workflow-id=${wf.id},pai.aws/task=${task}`;

export function targetsFromPods(pods: Pod[]): LogTarget[] {
  return pods.filter(p => p.metadata.uid && p.metadata.labels?.['pai.aws/attempt']).map(p => ({
    namespace: p.metadata.namespace!, podName: p.metadata.name, podUid: p.metadata.uid!,
    attempt: Number(p.metadata.labels!['pai.aws/attempt']), member: Number(p.metadata.labels!['batch.kubernetes.io/job-completion-index'] ?? 0),
    containers: [...(p.spec.initContainers ?? []), ...p.spec.containers].map(c => c.name), phase: p.status?.phase,
  })).sort((a, b) => b.attempt - a.attempt || a.member - b.member);
}
export async function resolveTargets(workflow: Workflow, taskName: string, list: typeof listPods = listPods): Promise<LogTarget[]> {
  return targetsFromPods(await list(workflow.namespace, taskSelector(workflow, taskName)));
}
export function pickTarget(targets: LogTarget[], want: { attempt?: number; member?: number }): LogTarget | undefined {
  const attempt = want.attempt ?? targets[0]?.attempt, member = want.member ?? 0;
  return targets.find(t => t.attempt === attempt && t.member === member);
}
export function pickContainer(target: LogTarget, want?: string): string {
  const name = want ?? (target.containers.includes('main') ? 'main' : target.containers[0]);
  if (!name || !target.containers.includes(name)) throw new HttpError(404, 'Container not found', 'log_container_not_found');
  return name;
}
export function splitLogLines(text: string): LogLine[] {
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.map(row => { const m = TS.exec(row); return m ? { ts: m[1], text: row.slice(m[0].length) } : { ts: '', text: row }; });
}
function bound(tail?: number) {
  const n = tail ?? LIMITS.tailDefault;
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMITS.tailMax) throw new HttpError(400, `tail must be 1–${LIMITS.tailMax}`, 'log_tail_out_of_range');
  return n;
}
export async function readLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; read?: typeof podLogs } = {}) {
  const raw = await (opts.read ?? podLogs)(target.namespace, target.podName, { container, tailLines: bound(opts.tail), sinceTime: opts.sinceTime, limitBytes: LIMITS.snapshotBytes + 1 });
  const text = opts.redactor ? Buffer.concat([opts.redactor.push(Buffer.from(raw)), opts.redactor.finish()]).toString('utf8') : raw;
  const truncated = Buffer.byteLength(raw) > LIMITS.snapshotBytes;
  const lines = splitLogLines(text);
  return { lines: truncated ? lines.slice(0, -1) : lines, truncated };
}
export async function* followLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; signal: AbortSignal; open?: typeof streamPodLogs }): AsyncGenerator<LogLine> {
  const body = await (opts.open ?? streamPodLogs)(target.namespace, target.podName, { container, tailLines: bound(opts.tail), sinceTime: opts.sinceTime, signal: opts.signal });
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const next = await reader.read();
      const bytes = next.done ? (opts.redactor?.finish() ?? Buffer.alloc(0)) : opts.redactor ? opts.redactor.push(next.value) : Buffer.from(next.value);
      pending += decoder.decode(bytes, { stream: !next.done });
      const rows = pending.split('\n'); const rest = rows.pop()!; pending = next.done ? '' : rest;
      for (const line of splitLogLines(rows.length ? rows.join('\n') + '\n' : '')) yield line;
      if (next.done) { if (rest) yield* splitLogLines(rest); return; }
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
