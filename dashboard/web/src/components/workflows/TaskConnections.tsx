'use client';
import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Card, ErrorBox, Select } from '@/components/ui';
import { api, can, useApi, useMe } from '@/lib/api-client';
import { translate, useT, type Locale, type Translator } from '@/lib/i18n';
import { isSafeLaunchUrl } from '@/lib/session-url';
import type { Task, Workflow } from '@/server/store/types';

export type ConnectionWorkflow = Pick<Workflow, 'id' | 'projectId' | 'ownerSubject' | 'status'>;
export type ConnectionTask = Pick<Task, 'workflowId' | 'name' | 'phase' | 'attempts' | 'outputPath'>;
type Action = 'tensorboard' | 'terminal' | 'files' | 'live';
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
function getTitles(t: Translator<'taskConnections'>): Record<Action, string> {
  return { tensorboard: t('titleTensorboard'), terminal: t('titleTerminal'), files: t('titleFiles'), live: t('titleLive') };
}
/** Reserved port names the compiler registers on the main container (see workflow/compile.ts). */
const PORT_NAMES = { files: 'pai-files', live: 'pai-live' } as const;

function resultPath(projectId: string | undefined, path: string | undefined): path is string {
  if (!projectId || !path || ![`/fsx/checkpoints/projects/${projectId}/`, `/fsx/datasets/projects/${projectId}/`].some((root) => path.startsWith(root))) return false;
  return path.slice(5).split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}
export function taskConnectionPayload(action: Action, workflow: ConnectionWorkflow, task: ConnectionTask, locale: Locale = 'ko') {
  const message = (key: 'errorProjectInfo' | 'errorNoPath' | 'errorNotRunning') => translate(locale, 'taskConnections', key);
  if (!workflow.projectId || task.workflowId !== workflow.id) throw new Error(message('errorProjectInfo'));
  if (action === 'tensorboard') {
    if (!resultPath(workflow.projectId, task.outputPath)) throw new Error(message('errorNoPath'));
    // Use the returned task directory exactly; TensorBoard discovers nested event logs.
    // This is an independent result viewer, with no live workflow/task capability.
    return { kind: 'tensorboard' as const, logDir: task.outputPath, ttlMinutes: 60 };
  }
  if (workflow.status !== 'RUNNING' || task.phase !== 'RUNNING') throw new Error(message('errorNotRunning'));
  const target = { workflowId: workflow.id, taskName: task.name, replicaIndex: 0, ttlMinutes: 60 };
  return action === 'terminal'
    ? { kind: 'terminal' as const, ...target }
    : { kind: 'port-forward' as const, ...target, portName: PORT_NAMES[action] };
}
export async function createTaskConnection(action: Action, workflow: ConnectionWorkflow, task: ConnectionTask, locale: Locale = 'ko') {
  const json = taskConnectionPayload(action, workflow, task, locale);
  return api<ConnectionSession>('/api/sessions', { method: 'POST', headers: { 'x-pai-project': workflow.projectId! }, json });
}

export function TaskConnections({ workflow, tasks, selectedTask, onSelectTask }: TaskConnectionsProps) {
  const t = useT('taskConnections');
  const tc = useT('common');
  const titles = getTitles(t);
  const me = useMe();
  const selectId = React.useId();
  const task = tasks.find((item) => item.name === (selectedTask ?? (tasks.length === 1 ? tasks[0].name : undefined)));
  const currentProject = me.data?.project;
  const research = can(me.data, 'researcher') && !(currentProject && currentProject.id === workflow.projectId && currentProject.role === 'viewer');
  const ownsRun = !!me.data?.subject && me.data.subject === workflow.ownerSubject;
  // Deployments without a wildcard session-host domain have no gateway; only an explicit false disables.
  const hostsConfigured = me.data?.features?.sessions !== false;
  const liveTask = !!task && task.workflowId === workflow.id && workflow.status === 'RUNNING' && task.phase === 'RUNNING';
  const interactive = research && ownsRun && !!workflow.projectId && liveTask && hostsConfigured;
  const options = useApi<ConnectionOptions>(interactive
    ? `/api/sessions/connect?workflowId=${encodeURIComponent(workflow.id)}&taskName=${encodeURIComponent(task!.name)}` : null,
    { refetch: 5000, init: { headers: { 'x-pai-project': workflow.projectId ?? '' } } });
  const replica = options.data?.replicas.find((item) => item.replicaIndex === 0);
  const terminalAvailable = interactive && !!replica && !options.error;
  const filesAvailable = terminalAvailable && !!replica?.ports.includes(PORT_NAMES.files);
  const liveAvailable = terminalAvailable && !!replica?.ports.includes(PORT_NAMES.live);
  const resultsAvailable = research && hostsConfigured && task?.workflowId === workflow.id && resultPath(workflow.projectId, task?.outputPath);
  const [connection, setConnection] = React.useState<PendingConnection>();
  const [busy, setBusy] = React.useState<'create' | 'launch'>();
  const [error, setError] = React.useState<unknown>();
  const [embed, setEmbed] = React.useState<{ sessionId: string; url: string }>();
  const [clock, setClock] = React.useState(Date.now);
  const operation = React.useRef(0);
  const inFlight = React.useRef(false);
  React.useEffect(() => {
    operation.current++;
    inFlight.current = false;
    setConnection(undefined); setBusy(undefined); setError(undefined); setEmbed(undefined);
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
    if (action === 'tensorboard' ? !resultsAvailable : action === 'terminal' ? !terminalAvailable : action === 'live' ? !liveAvailable : !filesAvailable) return;
    inFlight.current = true;
    const currentOperation = ++operation.current;
    setBusy('create'); setError(undefined);
    try {
      const created = await createTaskConnection(action, workflow, task, t.locale);
      if (currentOperation !== operation.current) return;
      const expectedKind = action === 'files' || action === 'live' ? 'port-forward' : action;
      if (!created.id || created.projectId !== workflow.projectId || created.kind !== expectedKind ||
        action !== 'tensorboard' && (created.workflowId !== workflow.id || created.taskName !== task.name)) {
        throw new Error(t('errorScope'));
      }
      setConnection({ action, workflowId: workflow.id, projectId: workflow.projectId, taskName: task.name,
        attempt: created.attempt ?? task.attempts, registeredAt: Date.now(), session: created });
      setEmbed(undefined);
      setClock(Date.now());
    } catch (cause) { if (currentOperation === operation.current) setError(cause); }
    finally { if (currentOperation === operation.current) { inFlight.current = false; setBusy(undefined); } }
  }
  async function open(embedded = false) {
    if (inFlight.current || !visible || !session || !openable) return;
    if (Date.parse(session.expiresAt!) <= Date.now()) { setClock(Date.now()); return; }
    // Live view renders inside the page: the session host is same-site, so the ticket exchange in an
    // iframe sets the session cookie without exposing pod content to the dashboard origin.
    const tab = embedded ? null : window.open('about:blank', '_blank');
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
      if (!isSafeLaunchUrl(url, session.id, me.data?.gateway)) {
        throw new Error(t('errorSafeAddress'));
      }
      if (embedded) setEmbed({ sessionId: session.id, url: url.toString() });
      else if (tab) tab.location.replace(url.toString()); else window.location.assign(url.toString());
    } catch (cause) {
      tab?.close();
      if (currentOperation === operation.current) { setError(cause); void sessions.refetch(); }
    } finally { if (currentOperation === operation.current) { inFlight.current = false; setBusy(undefined); } }
  }

  return <Card title={t('title')} description={t('description')}>
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <label htmlFor={selectId} className="w-full max-w-sm text-xs text-fg-muted">{t('taskLabel')}
        <Select id={selectId} className="mt-1" value={task?.name ?? ''} onChange={(event) => onSelectTask(event.target.value)} disabled={!!busy}>
          <option value="">{t('taskSelect')}</option>{tasks.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.phase}</option>)}
        </Select>
      </label>
      <Link href="/sessions" prefetch={false} className="text-xs text-accent hover:underline">{t('sessionManage')}</Link>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-label={t('resultsSectionTitle')} className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm font-semibold">{t('resultsSectionTitle')}</h3><Badge tone="info">{t('resultsBadge')}</Badge></div>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">{t('resultsDesc')}</p>
        <Button variant="primary" onClick={() => prepare('tensorboard')} disabled={!resultsAvailable || !!busy || samePending('tensorboard')}>{t('tensorboardPrepare')}</Button>
        {task && !resultPath(workflow.projectId, task.outputPath) && <p className="mt-2 text-xs text-fg-muted">{t('errorNoPath')}</p>}
      </section>
      <section aria-label={t('runningTaskTitle')} className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm font-semibold">{t('runningTaskTitle')}</h3><Badge tone="warn">{t('runningTaskBadge')}</Badge></div>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">{t('runningTaskDesc')}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => prepare('terminal')} disabled={!terminalAvailable || !!busy || samePending('terminal')}>{t('terminalPrepare')}</Button>
          <Button onClick={() => prepare('files')} disabled={!filesAvailable || !!busy || samePending('files')}>{t('filesPrepare')}</Button>
          <Button onClick={() => prepare('live')} disabled={!liveAvailable || !!busy || samePending('live')}>{t('livePrepare')}</Button>
        </div>
        {task && !liveTask && <p className="mt-2 text-xs text-fg-muted">{t('errorNotRunning')}</p>}
        {liveTask && !ownsRun && <p className="mt-2 text-xs text-fg-muted">{t('ownerOnly')}</p>}
        {interactive && !options.error && !replica && <p className="mt-2 text-xs text-fg-muted">{t('waitingConnection')}</p>}
        {terminalAvailable && !filesAvailable && <p className="mt-2 text-xs text-fg-muted">{t('noFilesFeature')}</p>}
        {terminalAvailable && !liveAvailable && <p className="mt-2 text-xs text-fg-muted">{t('noLiveFeature')}</p>}
      </section>
    </div>
    {!research && <p className="mt-3 text-xs text-fg-muted">{t('researcherRequired')}</p>}
    {!hostsConfigured && <p className="mt-3 text-xs text-fg-muted">{t('sessionHostMissing')}</p>}
    {(!!error || me.error || interactive && options.error) && <div className="mt-3"><ErrorBox error={error ?? me.error ?? options.error} /></div>}
    {busy === 'create' && <p role="status" className="mt-3 text-sm text-fg-muted">{t('preparingSession')}</p>}
    {visible && <div className="mt-4 rounded-lg border border-border bg-bg p-4" aria-label={t('taskConnectionStatus')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-medium">{visible.taskName} · {titles[visible.action]} · {t('attemptLabel')} {visible.attempt}</p>
          <p role="status" className="mt-1 text-xs text-fg-muted">
            {sessions.error ? t('sessionStatusUnknown') : !session
              ? clock - visible.registeredAt <= 60_000 ? t('sessionChecking') : t('sessionNotFound') :
              !liveConnection ? t('taskTerminated') :
                session.status === 'CLOSED' ? t('sessionClosed') : expired ? t('sessionExpired') :
                  session.status === 'CLOSING' ? t('sessionClosing') :
                    session.status === 'ERROR' ? t('sessionError') : openable ? (visible.action === 'live' ? t('readyEmbedded') : t('readyNewWindow')) :
                      session.status === 'READY' ? t('sessionNotReady') : t('sessionQueued')}
          </p></div>
        <span className="flex gap-2">
          {visible.action === 'live' && <Button variant="primary" disabled={!openable || !!busy} loading={busy === 'launch'} onClick={() => open(true)}>{t('openHere')}</Button>}
          <Button variant={visible.action === 'live' ? 'secondary' : 'primary'} disabled={!openable || !!busy} loading={busy === 'launch'} onClick={() => open(false)}>{visible.action === 'live' ? t('openNewWindow') : `${titles[visible.action]} ${tc('open')}`}</Button>
        </span>
      </div>
      {embed && visible.action === 'live' && session?.id === embed.sessionId && openable && (
        <div className="mt-3">
          <iframe src={embed.url} title={t('liveFrameTitle')} className="h-[520px] w-full rounded-md border border-border bg-black" referrerPolicy="no-referrer" allow="" />
          <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
            <span>{t('mjpegStream')}</span>
            <Button size="sm" variant="ghost" onClick={() => setEmbed(undefined)}>{t('closeEmbed')}</Button>
          </div>
        </div>
      )}
      {session?.message && !openable && <p className="mt-2 text-xs text-fg-muted">{session.message}</p>}
      {sessions.error && <ErrorBox error={sessions.error} className="mt-2" />}
      <p className="mt-3 text-xs text-fg-muted">{t('sessionTimeInfo')}</p>
    </div>}
  </Card>;
}
