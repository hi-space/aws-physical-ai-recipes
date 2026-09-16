'use client';
import { useState, useEffect, useRef } from 'react';
import { Select, Badge, Toggle, Button, Input, Spinner, ErrorBox } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import type { Task } from '@/server/store/types';
import type { ReplayPage } from '@/server/logs/http';
import type { LogHead } from '@/server/logs/types';
import { LogReplay } from './log-replay';

interface LogViewerProps { workflowId: string; tasks: Task[]; selectedTask?: string }
export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
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
        catch (e) { own.close(); setError(e instanceof Error ? e : new Error('로그 재생 오류')); }
      };
      own.addEventListener('page', receive);
      own.addEventListener('end', event => { receive(event); own.close(); });
      own.addEventListener('log-error', () => { own.close(); setError(new Error('로그 재생 권한 또는 커서가 만료되었습니다. 다시 열어 주세요.')); });
      own.onerror = () => {
        own.close(); if (!stopped) { setError(new Error('연결이 끊어졌습니다. 저장된 위치에서 다시 연결합니다.')); schedule(2000); }
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
        setError(e instanceof Error ? e : new Error('로그 조회 실패'));
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
      <label className="flex-1 min-w-40 text-xs">Task<Select value={task} onChange={e => setTask(e.target.value)}>
        {tasks.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
      </Select></label>
      <label className="flex-1 min-w-40 text-xs">저장된 로그 소스<Select value={streamId} onChange={e => setChoice({ task: `${workflowId}/${task}`, id: e.target.value })}>
        <option value="">최근 시도 · 첫 번째 멤버</option>
        {streams.map(s => <option key={s.id} value={s.id}>시도 {s.scope.attempt} · 멤버 {s.scope.member} · {s.scope.container} · {s.scope.podName} · 재시작 {s.scope.restartCount} · UID {s.scope.podUid.slice(0, 8)}</option>)}
      </Select></label>
      <label className="text-xs">시작 위치<Select value={start} onChange={e => setStart(e.target.value)}><option value="tail">최근 저장된 로그</option><option value="beginning">보관된 처음부터</option></Select></label>
      <Toggle checked={follow} onChange={setFollow} label="실시간 보기" />
      <Badge tone="info">{streams.length ? '보관 로그' : '수집 대기'}</Badge>
    </div>
    {error && <ErrorBox error={error} />}
    {activeSource && <p className="text-xs text-fg-muted">현재 소스: 시도 {activeSource.scope.attempt} · 멤버 {activeSource.scope.member} · {activeSource.scope.container} · Pod UID {activeSource.scope.podUid} · {activeSource.state}</p>}
    {gaps.length > 0 && <p role="status" className="text-xs text-fg-muted">수집 범위 정보: {Array.from(new Set(gaps)).join(', ')}. 연결 중단 이전이나 회전된 원본 로그는 누락될 수 있습니다.</p>}
    <div className="flex gap-2"><Input aria-label="로그 필터" placeholder="로그 검색…" value={filter} onChange={e => setFilter(e.target.value)} className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setReload(n => n + 1)}>다시 열기</Button>
      <Button size="sm" variant="ghost" onClick={download} disabled={!text}>표시 로그 다운로드</Button>
    </div>
    <div ref={scroll} onScroll={e => { const el = e.currentTarget; userScrolled.current = el.scrollTop < el.scrollHeight - el.clientHeight - 10; }} aria-label="작업 로그" className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
      {loading && <Spinner />}
      {!loading && !text && <p className="text-xs text-fg-muted">아직 보관된 로그가 없습니다.</p>}
      {lines.map((line, i) => !filter || line.toLowerCase().includes(filter.toLowerCase()) ? <div key={i} style={{ whiteSpace: 'pre-wrap' }}><span className="ln">{i + 1}</span>{line}</div> : null)}
    </div>
    <p className="text-xs text-fg-muted">저장 완료된 바이트를 커서로 재생합니다. 원본 전체 수집을 보장하지 않습니다. 화면은 최대 10,000줄 / 1,048,576자로 제한됩니다.{truncated ? ' 이전 화면 내용이 잘렸습니다. 보관 로그는 유지됩니다.' : ''}</p>
  </div>;
}
