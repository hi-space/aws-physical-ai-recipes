'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Select, Badge, Toggle, Button, Input, Spinner } from '@/components/ui';
import { api } from '@/lib/api-client';
import type { Task, TaskPhase } from '@/server/store/types';

interface Pod {
  name: string;
  phase: TaskPhase;
  node?: string;
  index?: number;
}

interface LogViewerProps {
  workflowId: string;
  tasks: Task[];
  selectedTask?: string;
}

interface LogMeta {
  source: 'kubernetes' | 'cloudwatch';
  pods: Pod[];
  pod: string;
  phase: TaskPhase;
  lines: string[];
}

export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
  const [task, setTask] = useState<string>(selectedTask || tasks?.[0]?.name || '');
  const [pod, setPod] = useState<string>('');
  const [pods, setPods] = useState<Pod[]>([]);
  const [tail, setTail] = useState<number>(1000);
  const [follow, setFollow] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<'kubernetes' | 'cloudwatch'>('kubernetes');
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const selectedTaskObj = tasks.find((t) => t.name === task);

  useEffect(() => {
    if (selectedTask && selectedTask !== task) {
      setTask(selectedTask);
    }
  }, [selectedTask, task]);

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    if (!task) return;
    setLoading(true);
    try {
      const url = `/api/workflows/${workflowId}/tasks/${task}/logs?tail=${tail}${pod ? `&pod=${pod}` : ''}`;
      const meta = await api<LogMeta>(url);
      setLines(meta.lines || []);
      setPods(meta.pods || []);
      setSource(meta.source);
      if (!pod && meta.pod) setPod(meta.pod);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  }, [workflowId, task, tail, pod]);

  useEffect(() => {
    if (follow && selectedTaskObj?.phase === 'RUNNING') {
      const eventSource = new EventSource(`/api/workflows/${workflowId}/tasks/${task}/logs?tail=${tail}${pod ? `&pod=${pod}` : ''}&follow=1`);
      eventSource.addEventListener('meta', (e) => {
        const meta = JSON.parse(e.data);
        setPods(meta.pods || []);
      });
      eventSource.addEventListener('message', (e) => {
        const newLines = JSON.parse(e.data);
        setLines((prev) => [...prev, ...newLines]);
        if (!userScrolled && scrollRef.current) {
          setTimeout(() => {
            scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
          }, 0);
        }
      });
      eventSource.addEventListener('end', () => {
        eventSource.close();
      });
      return () => eventSource.close();
    } else {
      const timer = setInterval(fetchLogs, 10_000);
      fetchLogs();
      return () => clearInterval(timer);
    }
  }, [follow, task, tail, pod, workflowId, selectedTaskObj?.phase, fetchLogs, userScrolled]);

  const filteredLines = lines.filter((line) => !filter || line.toLowerCase().includes(filter.toLowerCase()));

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setUserScrolled(el.scrollTop < el.scrollHeight - el.clientHeight - 10);
  };

  const downloadLogs = () => {
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${task}-logs.txt`;
    a.click();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-40">
          <label className="block text-xs font-medium mb-1">Task</label>
          <Select value={task} onChange={(e) => setTask(e.target.value)}>
            {tasks.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        {pods.length > 0 && (
          <div className="flex-1 min-w-40">
            <label className="block text-xs font-medium mb-1">Pod</label>
            <Select value={pod} onChange={(e) => setPod(e.target.value)}>
              <option value="">All pods</option>
              {pods.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex-1 min-w-40">
          <label className="block text-xs font-medium mb-1">Tail size</label>
          <Select value={String(tail)} onChange={(e) => setTail(Number(e.target.value))}>
            <option value="200">200</option>
            <option value="1000">1000</option>
            <option value="5000">5000</option>
          </Select>
        </div>
        <label className="flex items-center gap-2">
          <Toggle checked={follow} onChange={setFollow} />
          <span className="text-xs">Follow</span>
        </label>
        <Badge tone="info">{source}</Badge>
      </div>

      <div className="flex gap-2">
        <Input placeholder="Filter logs..." value={filter} onChange={(e) => setFilter(e.target.value)} className="flex-1" />
        <Button size="sm" variant="ghost" onClick={downloadLogs}>
          Download
        </Button>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
        {loading && <Spinner />}
        {filteredLines.map((line, idx) => (
          <div key={idx}>
            <span className="ln">{idx + 1}</span>
            {line}
          </div>
        ))}
      </div>

      {!userScrolled && follow && (
        <div className="text-center text-xs text-gray-400 cursor-pointer hover:text-gray-200" onClick={() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)}>
          ↓ Jump to latest
        </div>
      )}
    </div>
  );
}
