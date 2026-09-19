'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ErrorBox, Input, Select, Spinner, Toggle } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { Task } from '@/server/store/types';
import type { LogLine, LogSnapshot, LogTarget } from '@/server/logs/types';

const MAX_LINES = 10_000;
interface LogViewerProps { workflowId: string; tasks: Task[]; selectedTask?: string }
const key = (t: LogTarget) => `${t.attempt}/${t.member}`;
export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
  const t = useT('logs');
  const [task, setTask] = useState(selectedTask || tasks[0]?.name || '');
  const [targetKey, setTargetKey] = useState('');
  const [container, setContainer] = useState('');
  const [follow, setFollow] = useState(() => tasks.some(x => x.name === task && x.phase === 'RUNNING'));
  const [snapshot, setSnapshot] = useState<LogSnapshot>();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const scroll = useRef<HTMLDivElement>(null), userScrolled = useRef(false), lastTs = useRef('');
  const followRef = useRef(follow);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const connectRef = useRef<() => void>(() => {});
  const readRef = useRef<() => void>(() => {});
  const snapshotRef = useRef<LogSnapshot | undefined>(undefined);
  const fetchingRef = useRef(false);
  useEffect(() => { if (selectedTask) setTask(selectedTask); }, [selectedTask]);
  useEffect(() => { if (!tasks.some(x => x.name === task)) setTask(tasks[0]?.name ?? ''); }, [tasks, task]);
  useEffect(() => {
    const abort = new AbortController();
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    setLines([]); setTruncated(false); setSnapshot(undefined); setError(null); setLoading(!!task); lastTs.current = ''; userScrolled.current = false;
    sourceRef.current?.close(); sourceRef.current = undefined; snapshotRef.current = undefined;
    const base = `/api/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(task)}/logs`;
    const [attempt, member] = targetKey.split('/');
    const query = (extra: Record<string, string> = {}) => new URLSearchParams({ ...(attempt ? { attempt, member } : {}), ...(container ? { container } : {}), ...extra });
    const append = (next: LogLine[]) => setLines(prev => {
      const seen = new Set(prev.slice(-64).map(l => `${l.ts}|${l.text}`));
      const merged = [...prev, ...next.filter(l => !l.ts || !seen.has(`${l.ts}|${l.text}`))];
      if (merged.length > MAX_LINES) { setTruncated(true); return merged.slice(-MAX_LINES); }
      return merged;
    });
    // SSE only ever opens against a snapshot we already fetched and confirmed is a live pod;
    // never against a stale/unknown state (avoids polling a JSON-only endpoint as if it streamed).
    const connect = () => {
      const snap = snapshotRef.current;
      if (!(snap?.source === 'kubernetes' && snap.phase === 'Running')) return;
      sourceRef.current?.close();
      const source = new EventSource(`${base}?${query({ follow: '1', ...(lastTs.current ? { since: lastTs.current } : {}) })}`);
      sourceRef.current = source;
      const close = () => { source.close(); if (sourceRef.current === source) sourceRef.current = undefined; };
      source.addEventListener('line', event => { if (stopped) return; const line = JSON.parse((event as MessageEvent).data) as LogLine; if (line.ts) lastTs.current = line.ts; append([line]); });
      source.addEventListener('end', event => { close(); if (stopped) return; const { reason } = JSON.parse((event as MessageEvent).data) as { reason: string }; if (reason === 'timeout' && followRef.current) connect(); else setFollow(false); });
      source.addEventListener('log-error', () => { close(); setError(new Error(t('permissionExpired'))); });
      // Reconnect via a fresh snapshot read (not a blind SSE retry): a connection error can mean the
      // pod ended or was never live to begin with, and only read() can tell the two apart.
      source.onerror = () => { close(); if (!stopped) { setError(new Error(t('connectionLost'))); timer = setTimeout(() => { if (followRef.current) readRef.current(); }, 2000); } };
    };
    connectRef.current = connect;
    async function read() {
      fetchingRef.current = true;
      try {
        const page = await api<LogSnapshot>(`${base}?${query({ tail: '1000' })}`, { signal: abort.signal });
        if (stopped) return;
        setSnapshot(page); snapshotRef.current = page; setLines(page.lines); setTruncated(page.truncated); lastTs.current = page.lines.at(-1)?.ts ?? '';
        if (followRef.current && !sourceRef.current && page.source === 'kubernetes' && page.phase === 'Running') connect();
        else if (followRef.current && page.source === 'none' && page.reason === 'not-started') timer = setTimeout(read, 3000);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e : new Error(t('loadFailed')));
        if (!(e instanceof ApiError) || e.status >= 500) timer = setTimeout(read, 3000);
      } finally { fetchingRef.current = false; if (!stopped) setLoading(false); }
    }
    readRef.current = () => void read();
    if (task) void read();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); sourceRef.current?.close(); sourceRef.current = undefined; };
  }, [workflowId, task, targetKey, container, reload, t]);
  useEffect(() => {
    followRef.current = follow;
    if (!follow) { sourceRef.current?.close(); sourceRef.current = undefined; return; }
    if (sourceRef.current || fetchingRef.current) return;
    const snap = snapshotRef.current;
    if (snap?.source === 'kubernetes' && snap.phase === 'Running') connectRef.current();
    else readRef.current();
  }, [follow]);
  useEffect(() => { if (follow && !userScrolled.current) scroll.current?.scrollTo(0, scroll.current.scrollHeight); }, [lines, follow]);
  const targets = snapshot?.targets ?? [];
  const status = snapshot?.source === 'none' ? (snapshot.reason === 'pod-gone' ? t('podGone') : t('notStarted')) : snapshot?.phase === 'Running' ? t('live') : snapshot ? t('ended') : '';
  const text = lines.map(l => l.text).join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = `${task}-displayed-logs.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-3">
    <div className="flex gap-3 items-end flex-wrap">
      <label className="flex-1 min-w-40 text-xs">{t('task')}<Select value={task} onChange={e => setTask(e.target.value)}>
        {tasks.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </Select></label>
      <label className="flex-1 min-w-40 text-xs">{t('target')}<Select value={targetKey} onChange={e => setTargetKey(e.target.value)}>
        <option value="">{t('targetLatest')}</option>
        {targets.map(x => <option key={key(x)} value={key(x)}>{t('attempt')} {x.attempt} · {t('member')} {x.member} · {x.podName} · {x.phase ?? ''}</option>)}
      </Select></label>
      <label className="text-xs">{t('container')}<Select value={container} onChange={e => setContainer(e.target.value)}>
        <option value="">main</option>
        {(snapshot?.target?.containers ?? []).filter(c => c !== 'main').map(c => <option key={c} value={c}>{c}</option>)}
      </Select></label>
      <Toggle checked={follow} onChange={setFollow} label={t('follow')} />
      {status && <Badge tone={snapshot?.source === 'none' ? 'warn' : 'info'}>{status}</Badge>}
    </div>
    {error && <ErrorBox error={error} />}
    {snapshot?.source === 'none' && <p role="status" className="text-xs text-fg-muted">{t('podGoneInfo')}</p>}
    {snapshot?.redaction === 'unavailable' && <p role="alert" className="text-xs text-warning">{t('redactionUnavailable')}</p>}
    <div className="flex gap-2"><Input aria-label={t('filterLabel')} placeholder={t('filterPlaceholder')} value={filter} onChange={e => setFilter(e.target.value)} className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setReload(n => n + 1)}>{t('reopen')}</Button>
      <Button size="sm" variant="ghost" onClick={download} disabled={!text}>{t('downloadShown')}</Button>
    </div>
    <div ref={scroll} onScroll={e => { const el = e.currentTarget; userScrolled.current = el.scrollTop < el.scrollHeight - el.clientHeight - 10; }} aria-label={t('logRegion')} className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
      {loading && <Spinner />}
      {!loading && !lines.length && <p className="text-xs text-fg-muted">{t('noLogsYet')}</p>}
      {lines.map((line, i) => !filter || line.text.toLowerCase().includes(filter.toLowerCase()) ? <div key={i} style={{ whiteSpace: 'pre-wrap' }}><span className="ln">{i + 1}</span>{line.text}</div> : null)}
    </div>
    <p className="text-xs text-fg-muted">{t('limitInfo')}{truncated ? ` ${t('truncatedWarning')}` : ''}</p>
  </div>;
}
