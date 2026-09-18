'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { DcvBrowserCard } from '@/components/sessions/DcvBrowserCard';
import { Badge, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Select, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { useT, useFormat } from '@/lib/i18n';
import { api, can, useApi, useMe, type Me } from '@/lib/api-client';

type Kind = 'jupyter' | 'code-server' | 'tensorboard' | 'terminal' | 'port-forward';
interface PublicSession {
  id: string; kind: Kind; projectId?: string; namespace: string; owner: string; queue?: string;
  status: string; message?: string; createdAt: string; expiresAt?: string; logDir?: string;
  workflowId?: string; taskName?: string; attempt?: number; replicaIndex?: number;
  canOpen: boolean; canExtend: boolean; canEnd: boolean;
}
interface Project { id: string; name: string; namespace: string; queue: string; members: Record<string, string> }
interface Workflow { id: string; name: string; projectId?: string; ownerSubject?: string; status: string }
interface Task { name: string; phase: string; attempts: number }
interface ConnectionOptions { replicas: Array<{ replicaIndex: number; ports: string[] }> }

export function SessionsPage() {
  const t = useT('sessions');
  const tc = useT('common');
  const { fmtTime } = useFormat();
  const names: Record<Kind, string> = { jupyter: t('appJupyterLab'), 'code-server': t('appVsCode'), tensorboard: t('appTensorBoard'), terminal: t('appTerminal'), 'port-forward': t('appPortForward') };
  const me = useMe();
  const profile: (Me & { subject?: string }) | undefined = me.data;
  const sessions = useApi<PublicSession[]>('/api/sessions', { refetch: 5000 });
  const projects = useApi<Project[]>('/api/projects');
  const workflows = useApi<Workflow[]>(can(me.data, 'researcher') ? '/api/workflows?status=RUNNING' : null, { refetch: 10000 });
  const [showCreate, setShowCreate] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>('jupyter');
  const [projectId, setProjectId] = React.useState('');
  const [workflowId, setWorkflowId] = React.useState('');
  const [taskName, setTaskName] = React.useState('');
  const [replicaIndex, setReplicaIndex] = React.useState(0);
  const [portName, setPortName] = React.useState('');
  const [logDir, setLogDir] = React.useState('');
  const [ttlMinutes, setTtlMinutes] = React.useState(60);
  const [extending, setExtending] = React.useState<PublicSession>();
  const [extendMinutes, setExtendMinutes] = React.useState(120);
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<unknown>();
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' }>();
  const [clock, setClock] = React.useState(Date.now());
  React.useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const eligibleProjects = (projects.data ?? []).filter((p) => !!profile?.subject && ['researcher', 'project-admin'].includes(p.members[profile.subject]));
  const project = eligibleProjects.find((p) => p.id === projectId);
  React.useEffect(() => {
    if (!projectId && eligibleProjects.length) {
      const cookie = document.cookie.split('; ').find((part) => part.startsWith('pai-project='));
      let selected = ''; try { selected = decodeURIComponent(cookie?.slice(12) ?? ''); } catch { /* select the first accessible project */ }
      setProjectId(eligibleProjects.some((p) => p.id === selected) ? selected : eligibleProjects[0].id);
    }
  }, [eligibleProjects, projectId]);
  const attached = kind === 'terminal' || kind === 'port-forward';
  const ownWorkflows = (workflows.data ?? []).filter((wf) => wf.projectId === projectId && wf.ownerSubject === profile?.subject && wf.status === 'RUNNING');
  const tasks = useApi<{ tasks: Task[] }>(showCreate && attached && workflowId ? `/api/workflows/${encodeURIComponent(workflowId)}` : null, { refetch: 5000 });
  const connection = useApi<ConnectionOptions>(showCreate && attached && workflowId && taskName
    ? `/api/sessions/connect?workflowId=${encodeURIComponent(workflowId)}&taskName=${encodeURIComponent(taskName)}` : null,
    { refetch: 5000, init: { headers: { 'x-pai-project': projectId } } });
  const replicas = connection.data?.replicas ?? [];
  const selectedReplica = replicas.find((r) => r.replicaIndex === replicaIndex);
  React.useEffect(() => {
    if (replicas.length && !selectedReplica) setReplicaIndex(replicas[0].replicaIndex);
    if (kind === 'port-forward' && selectedReplica?.ports.length && !selectedReplica.ports.includes(portName)) setPortName(selectedReplica.ports[0]);
  }, [replicas, selectedReplica, portName, kind]);
  function changeProject(id: string) { setProjectId(id); setWorkflowId(''); setTaskName(''); setPortName(''); setLogDir(''); }
  async function create() {
    if (!project) return;
    setBusy('create'); setError(undefined);
    try {
      const common = { kind, ttlMinutes };
      const input = attached ? { ...common, workflowId, taskName, replicaIndex, ...(kind === 'port-forward' ? { portName } : {}) }
        : { ...common, ...(kind === 'tensorboard' ? { logDir } : {}) };
      const created = await api<PublicSession>('/api/sessions', { method: 'POST', headers: { 'x-pai-project': project.id }, json: input });
      setShowCreate(false); await sessions.refetch();
      setToast({ message: created.status === 'READY' ? t('sessionReadyToast') : t('sessionQueuedToast'), tone: 'ok' });
    } catch (err) { setError(err); } finally { setBusy(undefined); }
  }
  async function open(session: PublicSession) {
    const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
    setBusy(session.id); setError(undefined);
    try {
      const launch = await api<{ url: string }>(`/api/sessions/${session.id}/launch`, { method: 'POST' });
      if (tab) tab.location.replace(launch.url); else window.location.assign(launch.url);
    } catch (err) { tab?.close(); setError(err); await sessions.refetch(); } finally { setBusy(undefined); }
  }
  async function end(session: PublicSession) {
    if (!window.confirm(t('sessionConfirmEnd', { name: names[session.kind] ?? session.kind, id: session.id }))) return;
    setBusy(session.id); setError(undefined);
    try {
      const ended = await api<PublicSession>(`/api/sessions/${session.id}`, { method: 'DELETE' });
      setToast({ message: ended.status === 'CLOSED' ? t('sessionEndedToast') : t('sessionEndingToast'), tone: 'ok' });
      await sessions.refetch();
    } catch (err) { setError(err); await sessions.refetch(); } finally { setBusy(undefined); }
  }
  async function extend() {
    if (!extending) return;
    setBusy(extending.id); setError(undefined);
    try {
      await api(`/api/sessions/${extending.id}`, { method: 'PATCH', json: { ttlMinutes: extendMinutes } });
      setExtending(undefined); await sessions.refetch();
      setToast({ message: t('sessionExtendedToast'), tone: 'ok' });
    } catch (err) { setError(err); } finally { setBusy(undefined); }
  }
  const canCreate = !!project && (!attached || !!workflowId && !!taskName && !!selectedReplica && (kind !== 'port-forward' || selectedReplica.ports.includes(portName))) && (kind !== 'tensorboard' || !!logDir) && ttlMinutes >= 5 && ttlMinutes <= 1440;
  const liveCount = sessions.data?.filter((s) => s.status !== 'CLOSED').length ?? 0;
  return <>
    <PageHeader title={t('title')} />
    {me.data?.features?.sessions === false && <ErrorBox className="mb-5" error={{ message: t('notConfigured') }} />}
    {me.data?.role === 'admin' && me.data?.features?.sessions !== false && <DcvBrowserCard />}
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <p className="max-w-2xl text-sm text-fg-muted">{t('intro')}</p>
      {can(me.data, 'researcher') && <Button variant="primary" onClick={() => { setShowCreate(true); setError(undefined); }}>{t('newSessionButton')}</Button>}
    </div>
    {(error || sessions.error || me.error) && <ErrorBox error={error ?? sessions.error ?? me.error} />}
    {sessions.isLoading && <Spinner label={tc('loading')} />}
    <Card title={t('cardTitle')} description={t('cardDesc', { liveCount, totalCount: sessions.data?.length ?? 0 })}>
      {!sessions.data?.length ? <EmptyState title={t('noSessions')} hint={t('noSessionsHint')} />
        : <Table head={[t('colSession'), t('colProjectQueue'), t('colReadiness'), t('colExpires'), t('colActions')]} dense>
          {sessions.data.map((s) => {
            const expired = !!s.expiresAt && Date.parse(s.expiresAt) <= clock;
            return <tr key={s.id}>
              <td><div className="font-medium">{names[s.kind] ?? s.kind}</div><div className="mt-1 font-mono text-[11px] text-fg-muted">{s.id}</div>
                <div className="mt-1 text-xs text-fg-muted">{s.taskName ? t('sessionTaskInfo', { taskName: s.taskName, attempt: s.attempt ?? 0, replicaIndex: s.replicaIndex ?? 0 }) : s.owner}</div></td>
              <td><div className="text-sm">{projects.data?.find((p) => p.id === s.projectId)?.name ?? s.projectId ?? t('sessionLegacy')}</div>
                <div className="mt-1 max-w-56 truncate text-xs text-fg-muted" title={s.queue}>{s.queue ?? s.namespace}</div></td>
              <td><StatusPill status={s.status} />{s.message && <p className="mt-1 max-w-64 text-xs text-fg-muted">{s.message}</p>}</td>
              <td className="text-xs"><div>{s.expiresAt ? fmtTime(s.expiresAt) : t('sessionNoExpiry')}</div>
                <div className="mt-1 text-fg-muted">{s.status === 'CLOSED' ? t('sessionClosed') : expired ? t('sessionExpired') : s.expiresAt ? t('sessionExpiringIn', { minutes: Math.max(0, Math.ceil((Date.parse(s.expiresAt) - clock) / 60000)) }) : t('sessionEndAndRecreate')}</div></td>
              <td><div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => open(s)} disabled={!s.canOpen || expired || !!busy}>{tc('open')}</Button>
                {s.canExtend && <Button size="sm" onClick={() => { setExtending(s); setExtendMinutes(Math.min(1440, Math.ceil((Date.parse(s.expiresAt!) - clock) / 60000) + 60)); }} disabled={expired || !!busy}>{t('sessionExtendButton')}</Button>}
                {s.canEnd && <Button size="sm" variant="danger" onClick={() => end(s)} disabled={!!busy}>{t('sessionEndButton')}</Button>}
              </div></td>
            </tr>;
          })}
        </Table>}
    </Card>
    <Dialog title={t('dialogTitle')} open={showCreate} onClose={() => !busy && setShowCreate(false)} footer={<>
      <Button onClick={() => setShowCreate(false)} disabled={!!busy}>{t('dialogCancel')}</Button><Button variant="primary" onClick={create} disabled={!canCreate || !!busy} loading={busy === 'create'}>{t('dialogCreate')}</Button>
    </>}>
      <div className="space-y-4">
        {Boolean(error) && <ErrorBox error={error} />}{projects.error && <ErrorBox error={projects.error} />}
        <label className="block text-sm">{t('dialogProjectLabel')}<Select className="mt-1" value={projectId} onChange={(e) => changeProject(e.target.value)}>
          <option value="">{t('dialogProjectEmpty')}</option>{eligibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></label>
        {!eligibleProjects.length && <p className="text-xs text-fg-muted">{t('dialogProjectHint')}</p>}
        {project && <p className="text-xs text-fg-muted">{t('dialogProjectQueue', { queue: project.queue })}</p>}
        <label className="block text-sm">{t('dialogApplicationLabel')}<Select className="mt-1" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPortName(''); }}>
          {Object.entries(names).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </Select></label>
        {kind === 'tensorboard' && <label className="block text-sm">{t('dialogTensorboardLabel')}<Input className="mt-1" value={logDir} onChange={(e) => setLogDir(e.target.value)} placeholder={t('dialogTensorboardPlaceholder', { projectId })} />
          <span className="mt-1 block text-xs text-fg-muted">{t('dialogTensorboardHint')}</span></label>}
        {attached && <>
          {workflows.error && <ErrorBox error={workflows.error} />}
          <label className="block text-sm">{t('dialogWorkflowLabel')}<Select className="mt-1" value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setTaskName(''); setPortName(''); }}>
            <option value="">{t('dialogWorkflowEmpty')}</option>{ownWorkflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.name} · {wf.id}</option>)}
          </Select></label>
          {!ownWorkflows.length && <p className="text-xs text-fg-muted">{t('dialogWorkflowHint')}</p>}
          {tasks.error && <ErrorBox error={tasks.error} />}
          <label className="block text-sm">{t('dialogTaskLabel')}<Select className="mt-1" value={taskName} onChange={(e) => { setTaskName(e.target.value); setPortName(''); }}>
            <option value="">{t('dialogTaskEmpty')}</option>{tasks.data?.tasks.filter((task) => task.phase === 'RUNNING').map((task) => <option key={task.name} value={task.name}>{t('dialogTaskAttempt', { name: task.name, attempts: task.attempts })}</option>)}
          </Select></label>
          {connection.error && <ErrorBox error={connection.error} />}
          <label className="block text-sm">{t('dialogReplicaLabel')}<Select className="mt-1" value={replicaIndex} onChange={(e) => { setReplicaIndex(Number(e.target.value)); setPortName(''); }}>
            {replicas.map((r) => <option key={r.replicaIndex} value={r.replicaIndex}>{t('dialogReplicaOption', { index: r.replicaIndex })}</option>)}
          </Select></label>
          {taskName && !connection.isLoading && !replicas.length && <p className="text-xs text-fg-muted">{t('dialogTaskHint')}</p>}
          {kind === 'port-forward' && <label className="block text-sm">{t('dialogPortLabel')}<Select className="mt-1" value={portName} onChange={(e) => setPortName(e.target.value)}>
            <option value="">{t('dialogPortEmpty')}</option>{selectedReplica?.ports.map((port) => <option key={port} value={port}>{port}</option>)}
          </Select><span className="mt-1 block text-xs text-fg-muted">{t('dialogPortHint')}</span></label>}
        </>}
        <label className="block text-sm">{t('dialogTimeLabel')}<Input className="mt-1" type="number" min={5} max={1440} value={ttlMinutes} onChange={(e) => setTtlMinutes(Number(e.target.value))} /></label>
      </div>
    </Dialog>
    <Dialog title={t('extendDialogTitle')} open={!!extending} onClose={() => !busy && setExtending(undefined)} footer={<>
      <Button onClick={() => setExtending(undefined)} disabled={!!busy}>{t('extendDialogCancel')}</Button><Button variant="primary" onClick={extend} disabled={!!busy}>{t('extendDialogSave')}</Button>
    </>}>
      {Boolean(error) && <ErrorBox error={error} />}
      <label className="block text-sm">{t('extendDialogLabel')}<Input className="mt-2" type="number" min={5} max={1440} value={extendMinutes} onChange={(e) => setExtendMinutes(Number(e.target.value))} /></label>
      <p className="mt-3 text-xs text-fg-muted">{t('extendDialogNote')}</p>
    </Dialog>
    {profile?.role === 'admin' && <div className="mt-6"><AdminDcvPanel t={t} /></div>}
    {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(undefined)} />}
  </>;
}

interface DcvWorkstation { instanceId: string; state: string; instanceType?: string; launchTime?: string; dcvUrl?: string; codeServerUrl?: string; hasSecret: boolean }
interface DcvNode { cluster: string; orchestrator: string; group: string; instanceId: string; instanceType: string; status: string; portForward: string; login: string }
function AdminDcvPanel({ t }: { t: ReturnType<typeof useT<'sessions'>> }) {
  const { ago } = useFormat();
  const dcv = useApi<{ workstation?: DcvWorkstation | { error: string }; nodes: DcvNode[] }>('/api/sessions/dcv', { refetch: 10000 });
  const [error, setError] = React.useState<unknown>(), [busy, setBusy] = React.useState(false);
  const [credentials, setCredentials] = React.useState<{ username: string; password: string }>();
  React.useEffect(() => { if (!credentials) return; const timer = setTimeout(() => setCredentials(undefined), 60000); return () => clearTimeout(timer); }, [credentials]);
  const ws = dcv.data?.workstation && !('error' in dcv.data.workstation) ? dcv.data.workstation : undefined;
  async function action(name: 'start' | 'stop' | 'credentials') {
    if (name === 'stop' && !window.confirm(t('adminDcvStopConfirm'))) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api<{ username: string; password: string }>(`/api/sessions/dcv/${name}`, { method: 'POST' });
      if (name === 'credentials') setCredentials(result); else await dcv.refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title={t('adminDcvTitle')} description={t('adminDcvDesc')}>
    {(error || dcv.error) && <ErrorBox error={error ?? dcv.error} />}
    {dcv.data?.workstation && 'error' in dcv.data.workstation && <ErrorBox error={new Error(dcv.data.workstation.error)} />}
    {dcv.isLoading && <Spinner label={t('adminDcvLoading')} />}
    {ws && <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><StatusPill status={ws.state} /><span className="font-mono text-xs">{t('adminDcvInstanceId', { instanceId: ws.instanceId, instanceType: ws.instanceType ?? '' })}</span>{ws.launchTime && <span className="text-xs text-fg-muted">{t('adminDcvStarted', { time: ago(ws.launchTime) })}</span>}</div>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => action(ws.state === 'stopped' ? 'start' : 'stop')}>{ws.state === 'stopped' ? t('adminDcvStart') : t('adminDcvStop')}</Button>
        {ws.dcvUrl && <Button onClick={() => window.open(ws.dcvUrl, '_blank', 'noopener,noreferrer')}>{t('adminDcvOpenDcv')}</Button>}
        {ws.codeServerUrl && <Button onClick={() => window.open(ws.codeServerUrl, '_blank', 'noopener,noreferrer')}>{t('adminDcvOpenEditor')}</Button>}
        {ws.hasSecret && <Button disabled={busy} onClick={() => action('credentials')}>{t('adminDcvCredentials')}</Button>}
      </div></div>}
    {credentials && <div className="mt-4 rounded border border-border p-3"><p className="mb-2 text-xs text-fg-muted">{t('adminDcvCredentialsHint')}</p>
      <div className="flex items-center gap-2"><code>{credentials.username}</code><CopyButton text={credentials.username} /></div>
      <div className="flex items-center gap-2"><code>{credentials.password}</code><CopyButton text={credentials.password} /></div><Button size="sm" onClick={() => setCredentials(undefined)}>{t('adminDcvHide')}</Button>
    </div>}
    {!!dcv.data?.nodes.length && <details className="mt-5"><summary className="cursor-pointer text-sm">{t('adminNodesTitle')}</summary>
      {dcv.data.nodes.map((node) => <div className="mt-3" key={`${node.cluster}-${node.instanceId}`}><div className="mb-2 flex items-center gap-2"><Badge>{t('adminNodesOrchestrator', { orchestrator: node.orchestrator })}</Badge><span className="text-xs">{t('adminNodesInstance', { instanceId: node.instanceId, instanceType: node.instanceType })}</span></div>
        <CodeBlock code={node.portForward} lang="bash" /><p className="mt-1 text-xs text-fg-muted">{t('adminNodesLogin', { login: node.login })}</p></div>)}
    </details>}
  </Card>;
}
