'use client';
import { useState, useEffect, useRef } from 'react';
import { Select, Badge, Toggle, Button, Input, Spinner, ErrorBox } from '@/components/ui';
import { api } from '@/lib/api-client';
import type { Task } from '@/server/store/types';

interface Pod {
  name: string;
  phase?: string;
  node?: string;
  index?: number | string;
}
interface LogViewerProps { workflowId: string; tasks: Task[]; selectedTask?: string }
interface LogMeta {
  source: 'kubernetes' | 'cloudwatch' | 'none';
  pods: Pod[];
  pod?: string;
  phase?: string;
  lines: string[];
}
const MAX_LINES = 10_000;

export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
  const [task, setTask] = useState(selectedTask || tasks[0]?.name || '');
  const selectedTaskObj = tasks.find((item) => item.name === task);
  const taskKey = `${workflowId}/${task}/${selectedTaskObj?.attempts ?? 0}`;
  const [podChoice, setPodChoice] = useState({ taskKey: '', pod: '' });
  const pod = podChoice.taskKey === taskKey ? podChoice.pod : '';
  const [pods, setPods] = useState<Pod[]>([]);
  const [tail, setTail] = useState(1000);
  const [follow, setFollow] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [source, setSource] = useState<LogMeta['source']>('none');
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [userScrolled, setUserScrolled] = useState(false);

  useEffect(() => {
    if (selectedTask) setTask(selectedTask);
  }, [selectedTask]);

  useEffect(() => {
    if (!tasks.some((item) => item.name === task)) setTask(tasks[0]?.name ?? '');
  }, [tasks, task]);

  useEffect(() => {
    const abort = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: EventSource | undefined;
    setLines([]);
    setPods([]);
    setError(null);
    setSource('none');
    setLoading(Boolean(task));
    userScrolledRef.current = false;
    setUserScrolled(false);
    if (!task) return () => abort.abort();

    const query = new URLSearchParams({ tail: String(tail), ...(pod ? { pod } : {}) });
    const url = `/api/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(task)}/logs?${query}`;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(readSnapshot, delay);
    };
    const connect = () => {
      stream = new EventSource(`${url}&follow=1`);
      const connection = stream;
      let disconnected = false;
      const recover = (message: string) => {
        if (disconnected) return;
        disconnected = true;
        connection.close();
        if (stopped) return;
        setError(new Error(message));
        schedule(5000);
      };
      connection.addEventListener('meta', (event) => {
        if (stopped || disconnected) return;
        try {
          const meta = JSON.parse(event.data) as { pods?: Pod[] };
          setPods(meta.pods ?? []);
          setSource('kubernetes');
          // The stream includes its own tail; replace the snapshot instead of duplicating it.
          setLines([]);
          setError(null);
        } catch {
          recover('로그 연결 정보를 읽지 못했습니다. 다시 조회합니다.');
        }
      });
      connection.addEventListener('message', (event) => {
        if (stopped || disconnected) return;
        try {
          const next: unknown = JSON.parse(event.data);
          if (!Array.isArray(next) || !next.every((line) => typeof line === 'string')) throw new Error('Invalid log chunk');
          setLines((previous) => [...previous, ...next].slice(-MAX_LINES));
          setError(null);
        } catch {
          recover('로그 데이터를 읽지 못했습니다. 다시 조회합니다.');
        }
      });
      connection.addEventListener('error', (event) => {
        let message = '로그 연결이 끊어졌습니다. 5초 후 다시 조회합니다.';
        if ('data' in event && typeof event.data === 'string') {
          try { message = (JSON.parse(event.data) as { error?: string }).error || message; } catch { /* use connection error */ }
        }
        recover(message);
      });
      connection.addEventListener('end', () => {
        if (disconnected) return;
        disconnected = true;
        connection.close();
        schedule(1000);
      });
    };
    async function readSnapshot() {
      try {
        const meta = await api<LogMeta>(url, { signal: abort.signal });
        if (stopped) return;
        setLines((meta.lines ?? []).slice(-MAX_LINES));
        setPods(meta.pods ?? []);
        setSource(meta.source);
        setError(null);
        const phase = meta.phase ?? meta.pods?.find((item) => item.name === meta.pod)?.phase;
        if (follow && selectedTaskObj?.phase === 'RUNNING' && phase === 'Running') connect();
        else schedule(10_000);
      } catch (failure) {
        if (stopped) return;
        setError(failure instanceof Error ? failure : new Error('로그 조회에 실패했습니다.'));
        schedule(10_000);
      } finally {
        if (!stopped) setLoading(false);
      }
    }
    void readSnapshot();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      stream?.close();
    };
  }, [workflowId, task, taskKey, pod, tail, follow, selectedTaskObj?.phase, selectedTaskObj?.jobName]);

  useEffect(() => {
    if (follow && !userScrolledRef.current) scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [lines, follow]);

  const filteredLines = lines.filter((line) => !filter || line.toLowerCase().includes(filter.toLowerCase()));
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const scrolled = element.scrollTop < element.scrollHeight - element.clientHeight - 10;
    userScrolledRef.current = scrolled;
    setUserScrolled(scrolled);
  };
  const downloadLogs = () => {
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${task}-logs.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-end flex-wrap">
        <label className="flex-1 min-w-40 text-xs">
          Task
          <Select value={task} onChange={(event) => setTask(event.target.value)}>
            {tasks.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </Select>
        </label>
        {pods.length > 0 && (
          <label className="flex-1 min-w-40 text-xs">
            Pod
            <Select value={pod} onChange={(event) => setPodChoice({ taskKey, pod: event.target.value })}>
              <option value="">자동 선택 (최신 Pod)</option>
              {pods.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.phase})</option>)}
            </Select>
          </label>
        )}
        <label className="flex-1 min-w-40 text-xs">
          최근 로그 줄 수
          <Select value={String(tail)} onChange={(event) => setTail(Number(event.target.value))}>
            <option value="200">200</option><option value="1000">1000</option><option value="5000">5000</option>
          </Select>
        </label>
        <label className="flex items-center gap-2"><Toggle checked={follow} onChange={setFollow} /><span className="text-xs">실시간 보기</span></label>
        <Badge tone="info">{source === 'none' ? '로그 대기 중' : source}</Badge>
      </div>
      {error && <ErrorBox error={error} />}
      <div className="flex gap-2">
        <Input aria-label="로그 필터" placeholder="로그 검색…" value={filter} onChange={(event) => setFilter(event.target.value)} className="flex-1" />
        <Button size="sm" variant="ghost" onClick={downloadLogs} disabled={!lines.length}>다운로드</Button>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} aria-label="작업 로그" className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
        {loading && <Spinner />}
        {!loading && !error && !filteredLines.length && <p className="text-xs text-fg-muted">표시할 로그가 없습니다.</p>}
        {filteredLines.map((line, index) => <div key={index}><span className="ln">{index + 1}</span>{line}</div>)}
      </div>
      <p className="text-xs text-fg-muted">최근 최대 {MAX_LINES.toLocaleString()}줄을 표시합니다.</p>
      {userScrolled && follow && (
        <Button size="sm" variant="ghost" onClick={() => {
          userScrolledRef.current = false;
          setUserScrolled(false);
          scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
        }}>↓ 최신 로그로 이동</Button>
      )}
    </div>
  );
}
