'use client';
import { useState, useEffect, useRef } from 'react';
import { Select, Badge, Toggle, Button, Input, Spinner, ErrorBox } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { Task } from '@/server/store/types';
import type { ReplayPage } from '@/server/logs/http';
import type { LogHead } from '@/server/logs/types';
import { LogReplay } from './log-replay';

interface LogViewerProps { workflowId: string; tasks: Task[]; selectedTask?: string }
export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
  const t = useT('logs');
  const [task, setTask] = useState(selectedTask || tasks[0]?.name || '');
  const [choice, setChoice] = useState({ task: '', id: '' });
  const streamId = choice.task === `${workflowId}/${task}` ? choice.id : '';
  const [streams, setStreams] = useState<LogHead[]>([]);
  const [activeSource, setActiveSource] = useState<LogHead>();
  const [start, setStart] = useState('tail');
  const [follow, setFollow] = useState(false);
  const [text, setText] = useState('');
  const [gaps, setGaps] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const scroll = useRef<HTMLDivElement>(null), userScrolled = useRef(false);
  const saved = useRef<{ key: string; replay: LogReplay } | null>(null);
  useEffect(() => { if (selectedTask) setTask(selectedTask); }, [selectedTask]);
  useEffect(() => { if (!tasks.some(t => t.name === task)) setTask(tasks[0]?.name ?? ''); }, [tasks, task]);
  useEffect(() => {
    const abort = new AbortController(), key = `${workflowId}/${task}/${streamId}/${start}/${reload}`;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, connection: EventSource | undefined;
    if (saved.current?.key !== key) {
      saved.current = { key, replay: new LogReplay() }; setText(''); setGaps([]); setStreams([]); setActiveSource(undefined); setTruncated(false);
    }
    const replay = saved.current.replay;
    setLoading(!!task); setError(null); userScrolled.current = false;
    const base = `/api/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(task)}/logs`;
    const query = () => new URLSearchParams({ start, ...(streamId ? { stream: streamId } : {}), ...(replay.cursor ? { cursor: replay.cursor } : {}) });
    const schedule = (delay: number) => { clearTimeout(timer); if (!stopped && follow) timer = setTimeout(read, delay); };
    const apply = (page: ReplayPage) => {
      replay.apply(page); setText(replay.text); setGaps(replay.gaps); setTruncated(replay.truncated);
      setStreams(page.streams); setActiveSource(page.stream); setError(null); setLoading(false);
    };
    const connect = () => {
      connection = new EventSource(`${base}?${query()}&follow=1`);
      const own = connection;
      const receive = (event: MessageEvent) => {
        if (stopped) return;
        try { apply(JSON.parse(event.data)); }
        catch (e) { own.close(); setError(e instanceof Error ? e : new Error(t('replayError'))); }
      };
      own.addEventListener('page', receive);
      own.addEventListener('end', event => { receive(event); own.close(); });
      own.addEventListener('log-error', () => { own.close(); setError(new Error(t('permissionExpired'))); });
      own.onerror = () => {
        own.close(); if (!stopped) { setError(new Error(t('connectionLost'))); schedule(2000); }
      };
    };
    async function read() {
      try {
        const page = await api<ReplayPage>(`${base}?${query()}`, { signal: abort.signal });
        if (stopped) return;
        apply(page);
        if (page.hasMore) timer = setTimeout(read, 0);
        else if (follow && page.stream?.state === 'open') connect();
        else if (follow && !page.stream) schedule(2000);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e : new Error(t('loadFailed')));
        if (!(e instanceof ApiError) || e.status >= 500) schedule(3000);
      } finally { if (!stopped) setLoading(false); }
    }
    if (task) void read();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); connection?.close(); };
  }, [workflowId, task, streamId, start, follow, reload]);
  useEffect(() => { if (follow && !userScrolled.current) scroll.current?.scrollTo(0, scroll.current.scrollHeight); }, [text, follow]);
  const lines = text ? text.split('\n') : [];
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = `${task}-displayed-logs.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-3">
    <div className="flex gap-3 items-end flex-wrap">
      <label className="flex-1 min-w-40 text-xs">{t('task')}<Select value={task} onChange={e => setTask(e.target.value)}>
        {tasks.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </Select></label>
      <label className="flex-1 min-w-40 text-xs">{t('source')}<Select value={streamId} onChange={e => setChoice({ task: `${workflowId}/${task}`, id: e.target.value })}>
        <option value="">{t('sourceLatest')}</option>
        {streams.map(s => <option key={s.id} value={s.id}>{t('streamAttempt')} {s.scope.attempt} · {t('streamMember')} {s.scope.member} · {s.scope.container} · {s.scope.podName} · {t('streamRestart')} {s.scope.restartCount} · UID {s.scope.podUid.slice(0, 8)}</option>)}
      </Select></label>
      <label className="text-xs">{t('startAt')}<Select value={start} onChange={e => setStart(e.target.value)}><option value="tail">{t('startTail')}</option><option value="beginning">{t('startBeginning')}</option></Select></label>
      <Toggle checked={follow} onChange={setFollow} label={t('follow')} />
      <Badge tone="info">{streams.length ? t('archived') : t('awaitingCollection')}</Badge>
    </div>
    {error && <ErrorBox error={error} />}
    {activeSource && <p className="text-xs text-fg-muted">{t('currentSource')}: {t('streamAttempt')} {activeSource.scope.attempt} · {t('streamMember')} {activeSource.scope.member} · {activeSource.scope.container} · Pod UID {activeSource.scope.podUid} · {activeSource.state}</p>}
    {gaps.length > 0 && <p role="status" className="text-xs text-fg-muted">{t('collectionInfo')}: {Array.from(new Set(gaps)).join(', ')}. {t('gapInfo')}</p>}
    <div className="flex gap-2"><Input aria-label={t('filterLabel')} placeholder={t('filterPlaceholder')} value={filter} onChange={e => setFilter(e.target.value)} className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setReload(n => n + 1)}>{t('reopen')}</Button>
      <Button size="sm" variant="ghost" onClick={download} disabled={!text}>{t('downloadShown')}</Button>
    </div>
    <div ref={scroll} onScroll={e => { const el = e.currentTarget; userScrolled.current = el.scrollTop < el.scrollHeight - el.clientHeight - 10; }} aria-label={t('logRegion')} className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
      {loading && <Spinner />}
      {!loading && !text && <p className="text-xs text-fg-muted">{t('noLogsYet')}</p>}
      {lines.map((line, i) => !filter || line.toLowerCase().includes(filter.toLowerCase()) ? <div key={i} style={{ whiteSpace: 'pre-wrap' }}><span className="ln">{i + 1}</span>{line}</div> : null)}
    </div>
    <p className="text-xs text-fg-muted">{t('logLimitInfo')}{truncated ? ` ${t('truncatedWarning')}` : ''}</p>
  </div>;
}
