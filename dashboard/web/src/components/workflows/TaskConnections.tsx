'use client';
import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Card, ErrorBox, Select } from '@/components/ui';
import { api, can, useApi, useMe } from '@/lib/api-client';
import type { Task, Workflow } from '@/server/store/types';

export type ConnectionWorkflow = Pick<Workflow, 'id' | 'projectId' | 'ownerSubject' | 'status'>;
export type ConnectionTask = Pick<Task, 'workflowId' | 'name' | 'phase' | 'attempts' | 'outputPath'>;
type Action = 'tensorboard' | 'terminal' | 'files';
interface ConnectionSession {
  id: string;
  kind: 'tensorboard' | 'terminal' | 'port-forward';
  projectId?: string;
  workflowId?: string;
  taskName?: string;
  attempt?: number;
  status: string;
  message?: string;
  expiresAt?: string;
  canOpen: boolean;
}
interface PendingConnection {
  action: Action;
  workflowId: string;
  projectId: string;
  taskName: string;
  attempt: number;
  registeredAt: number;
  session: ConnectionSession;
}
interface ConnectionOptions { replicas: Array<{ replicaIndex: number; ports: string[] }> }
interface TaskConnectionsProps {
  workflow: ConnectionWorkflow;
  tasks: ConnectionTask[];
  selectedTask?: string;
  onSelectTask(name: string): void;
}
const titles: Record<Action, string> = { tensorboard: 'TensorBoard', terminal: '터미널', files: '작업 파일' };

function resultPath(projectId: string | undefined, path: string | undefined): path is string {
  if (!projectId || !path || ![`/fsx/checkpoints/projects/${projectId}/`, `/fsx/datasets/projects/${projectId}/`].some((root) => path.startsWith(root))) return false;
  return path.slice(5).split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}
export function taskConnectionPayload(action: Action, workflow: ConnectionWorkflow, task: ConnectionTask) {
  if (!workflow.projectId || task.workflowId !== workflow.id) throw new Error('작업의 프로젝트 정보를 확인할 수 없습니다.');
  if (action === 'tensorboard') {
    if (!resultPath(workflow.projectId, task.outputPath)) throw new Error('아직 사용할 수 있는 프로젝트 결과 경로가 없습니다.');
    // Use the returned task directory exactly; TensorBoard discovers nested event logs.
    // This is an independent result viewer, with no live workflow/task capability.
    return { kind: 'tensorboard' as const, logDir: task.outputPath, ttlMinutes: 60 };
  }
  if (workflow.status !== 'RUNNING' || task.phase !== 'RUNNING') throw new Error('터미널과 작업 파일은 실행 중인 작업에서만 열 수 있습니다.');
  const target = { workflowId: workflow.id, taskName: task.name, replicaIndex: 0, ttlMinutes: 60 };
  return action === 'terminal'
    ? { kind: 'terminal' as const, ...target }
    : { kind: 'port-forward' as const, ...target, portName: 'pai-files' };
}
export async function createTaskConnection(action: Action, workflow: ConnectionWorkflow, task: ConnectionTask) {
  const json = taskConnectionPayload(action, workflow, task);
  return api<ConnectionSession>('/api/sessions', { method: 'POST', headers: { 'x-pai-project': workflow.projectId! }, json });
}

export function TaskConnections({ workflow, tasks, selectedTask, onSelectTask }: TaskConnectionsProps) {
  const me = useMe();
  const selectId = React.useId();
  const task = tasks.find((item) => item.name === (selectedTask ?? (tasks.length === 1 ? tasks[0].name : undefined)));
  const currentProject = me.data?.project;
  const research = can(me.data, 'researcher') && !(currentProject && currentProject.id === workflow.projectId && currentProject.role === 'viewer');
  const ownsRun = !!me.data?.subject && me.data.subject === workflow.ownerSubject;
  const liveTask = !!task && task.workflowId === workflow.id && workflow.status === 'RUNNING' && task.phase === 'RUNNING';
  const interactive = research && ownsRun && !!workflow.projectId && liveTask;
  const options = useApi<ConnectionOptions>(interactive
    ? `/api/sessions/connect?workflowId=${encodeURIComponent(workflow.id)}&taskName=${encodeURIComponent(task!.name)}` : null,
    { refetch: 5000, init: { headers: { 'x-pai-project': workflow.projectId ?? '' } } });
  const replica = options.data?.replicas.find((item) => item.replicaIndex === 0);
  const terminalAvailable = interactive && !!replica && !options.error;
  const filesAvailable = terminalAvailable && !!replica?.ports.includes('pai-files');
  const resultsAvailable = research && task?.workflowId === workflow.id && resultPath(workflow.projectId, task?.outputPath);
  const [connection, setConnection] = React.useState<PendingConnection>();
  const [busy, setBusy] = React.useState<'create' | 'launch'>();
  const [error, setError] = React.useState<unknown>();
  const [clock, setClock] = React.useState(Date.now);
  const operation = React.useRef(0);
  const inFlight = React.useRef(false);
  React.useEffect(() => {
    operation.current++;
    inFlight.current = false;
    setConnection(undefined); setBusy(undefined); setError(undefined);
    return () => { operation.current++; };
  }, [workflow.id]);
  React.useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connection]);

  const visible = connection?.workflowId === workflow.id ? connection : undefined;
  const sessions = useApi<ConnectionSession[]>(visible ? '/api/sessions' : null, {
    init: { headers: { 'x-pai-project': visible?.projectId ?? '' } },
    refetchInterval: (query) => {
      if (!visible) return false;
      const row = query.state.data?.find((item) => item.id === visible.session.id);
      // Newly written sessions may lag in the listing index. Keep checking briefly,
      // but never treat an absent row in a returned list as a ready session.
      if (query.state.data && !row && Date.now() - visible.registeredAt > 60_000) return false;
      const current = row ?? visible.session;
      return ['CLOSED', 'ERROR'].includes(current.status) || !current.expiresAt || Date.parse(current.expiresAt) <= Date.now() ? false : 2000;
    },
  });
  const session = visible ? sessions.data ? sessions.data.find((item) => item.id === visible.session.id) : visible.session : undefined;
  const connectionTask = tasks.find((item) => item.name === visible?.taskName);
  const liveConnection = visible?.action === 'tensorboard' || research && ownsRun && workflow.status === 'RUNNING' &&
    connectionTask?.phase === 'RUNNING' && connectionTask.attempts === visible?.attempt;
  const expired = !session?.expiresAt || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= clock;
  const openable = research && !!session && session.projectId === visible?.projectId && session.status === 'READY' &&
    session.canOpen && !expired && liveConnection && !sessions.error;
  const samePending = (action: Action) => !!visible && visible.action === action && visible.taskName === task?.name &&
    visible.attempt === task?.attempts && !!session && !['CLOSED', 'ERROR'].includes(session.status) && !expired;

  async function prepare(action: Action) {
    if (inFlight.current || !task || !workflow.projectId || samePending(action)) return;
    if (action === 'tensorboard' ? !resultsAvailable : action === 'terminal' ? !terminalAvailable : !filesAvailable) return;
    inFlight.current = true;
    const currentOperation = ++operation.current;
    setBusy('create'); setError(undefined);
    try {
      const created = await createTaskConnection(action, workflow, task);
      if (currentOperation !== operation.current) return;
      const expectedKind = action === 'files' ? 'port-forward' : action;
      if (!created.id || created.projectId !== workflow.projectId || created.kind !== expectedKind ||
        action !== 'tensorboard' && (created.workflowId !== workflow.id || created.taskName !== task.name)) {
        throw new Error('생성된 세션의 작업 범위를 확인할 수 없습니다. 세션 목록에서 확인하세요.');
      }
      setConnection({ action, workflowId: workflow.id, projectId: workflow.projectId, taskName: task.name,
        attempt: created.attempt ?? task.attempts, registeredAt: Date.now(), session: created });
      setClock(Date.now());
    } catch (cause) { if (currentOperation === operation.current) setError(cause); }
    finally { if (currentOperation === operation.current) { inFlight.current = false; setBusy(undefined); } }
  }
  async function open() {
    if (inFlight.current || !visible || !session || !openable) return;
    if (Date.parse(session.expiresAt!) <= Date.now()) { setClock(Date.now()); return; }
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    inFlight.current = true;
    const currentOperation = ++operation.current;
    setBusy('launch'); setError(undefined);
    try {
      // Every click requests a fresh one-use launch URL; no ticket is retained in component state.
      const launch = await api<{ url: string }>(`/api/sessions/${encodeURIComponent(session.id)}/launch`, {
        method: 'POST', headers: { 'x-pai-project': visible.projectId },
      });
      if (currentOperation !== operation.current) { tab?.close(); return; }
      const url = new URL(launch.url);
      if (url.protocol !== 'https:' || !url.hostname.startsWith(`${session.id}.`) || url.username || url.password || !url.searchParams.get('ticket')) {
        throw new Error('안전한 세션 주소를 확인할 수 없습니다.');
      }
      if (tab) tab.location.replace(url.toString()); else window.location.assign(url.toString());
    } catch (cause) {
      tab?.close();
      if (currentOperation === operation.current) { setError(cause); void sessions.refetch(); }
    } finally { if (currentOperation === operation.current) { inFlight.current = false; setBusy(undefined); } }
  }

  return <Card title="작업 결과와 접속" description="작업을 선택하면 결과 보기와 접속을 바로 준비할 수 있습니다.">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <label htmlFor={selectId} className="w-full max-w-sm text-xs text-fg-muted">작업
        <Select id={selectId} className="mt-1" value={task?.name ?? ''} onChange={(event) => onSelectTask(event.target.value)} disabled={!!busy}>
          <option value="">작업 선택</option>{tasks.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.phase}</option>)}
        </Select>
      </label>
      <Link href="/sessions" prefetch={false} className="text-xs text-accent hover:underline">세션 관리 · 고급 연결</Link>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-label="저장된 결과" className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm font-semibold">저장된 결과</h3><Badge tone="info">읽기 전용</Badge></div>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">완료된 학습도 TensorBoard로 볼 수 있습니다. 작업에 저장된 결과 경로를 자동으로 사용합니다.</p>
        <Button variant="primary" onClick={() => prepare('tensorboard')} disabled={!resultsAvailable || !!busy || samePending('tensorboard')}>TensorBoard 준비</Button>
        {task && !resultPath(workflow.projectId, task.outputPath) && <p className="mt-2 text-xs text-fg-muted">아직 사용할 수 있는 프로젝트 결과 경로가 없습니다.</p>}
      </section>
      <section aria-label="실행 중인 작업" className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm font-semibold">실행 중인 작업</h3><Badge tone="warn">코드·파일 수정 가능</Badge></div>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">실행 소유자만 연결할 수 있습니다. 터미널 명령과 파일 수정은 현재 작업에 반영됩니다.</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => prepare('terminal')} disabled={!terminalAvailable || !!busy || samePending('terminal')}>터미널 준비</Button>
          <Button onClick={() => prepare('files')} disabled={!filesAvailable || !!busy || samePending('files')}>작업 파일 준비</Button>
        </div>
        {task && !liveTask && <p className="mt-2 text-xs text-fg-muted">터미널과 작업 파일은 실행 중인 작업에서만 열 수 있습니다.</p>}
        {liveTask && !ownsRun && <p className="mt-2 text-xs text-fg-muted">이 실행을 시작한 계정으로 연결하세요.</p>}
        {interactive && !options.error && !replica && <p className="mt-2 text-xs text-fg-muted">작업 연결이 준비되기를 기다리고 있습니다.</p>}
        {terminalAvailable && !filesAvailable && <p className="mt-2 text-xs text-fg-muted">이 작업에는 파일 보기 기능이 설정되어 있지 않습니다.</p>}
      </section>
    </div>
    {!research && <p className="mt-3 text-xs text-fg-muted">프로젝트 연구자 권한이 있어야 결과 세션이나 작업 접속을 준비할 수 있습니다.</p>}
    {(!!error || me.error || interactive && options.error) && <div className="mt-3"><ErrorBox error={error ?? me.error ?? options.error} /></div>}
    {busy === 'create' && <p role="status" className="mt-3 text-sm text-fg-muted">세션을 준비하고 있습니다…</p>}
    {visible && <div className="mt-4 rounded-lg border border-border bg-bg p-4" aria-label="준비한 세션">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-medium">{visible.taskName} · {titles[visible.action]} · 시도 {visible.attempt}</p>
          <p role="status" className="mt-1 text-xs text-fg-muted">
            {sessions.error ? '세션 상태를 확인하지 못했습니다.' : !session
              ? clock - visible.registeredAt <= 60_000 ? '세션 등록 상태를 확인하고 있습니다.' : '세션이 더 이상 보이지 않습니다. 세션 관리에서 확인하세요.' :
              !liveConnection ? '작업이 종료되거나 재시작되어 이 접속은 다시 열 수 없습니다.' :
                session.status === 'CLOSED' ? '세션이 종료되었습니다.' : expired ? '세션이 만료되었습니다. 다시 준비하세요.' :
                  session.status === 'CLOSING' ? '접속을 종료하고 있습니다.' :
                    session.status === 'ERROR' ? '세션 준비에 실패했습니다.' : openable ? '준비가 끝났습니다. 새 창에서 열 수 있습니다.' :
                      session.status === 'READY' ? '현재 권한으로 세션을 열 수 없습니다.' : '프로젝트 대기열에서 세션을 준비하고 있습니다. 준비되면 열기 버튼이 활성화됩니다.'}
          </p></div>
        <Button variant="primary" disabled={!openable || !!busy} loading={busy === 'launch'} onClick={open}>{titles[visible.action]} 열기</Button>
      </div>
      {session?.message && !openable && <p className="mt-2 text-xs text-fg-muted">{session.message}</p>}
      {sessions.error && <ErrorBox error={sessions.error} className="mt-2" />}
      <p className="mt-3 text-xs text-fg-muted">세션 이용 시간은 기본 1시간입니다. 세션 관리에서 연장하거나 종료할 수 있습니다.</p>
    </div>}
  </Card>;
}
