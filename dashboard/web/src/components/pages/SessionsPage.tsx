'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { DcvBrowserCard } from '@/components/sessions/DcvBrowserCard';
import { Badge, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Select, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { ago, fmtTime } from '@/lib/format';
import { api, can, useApi, useMe, type Me } from '@/lib/api-client';

type Kind = 'jupyter' | 'code-server' | 'tensorboard' | 'terminal' | 'port-forward';
const names: Record<Kind, string> = { jupyter: 'JupyterLab', 'code-server': 'VS Code', tensorboard: 'TensorBoard', terminal: 'Task terminal', 'port-forward': 'Task application' };
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
      setToast({ message: created.status === 'READY' ? 'Task session is ready to open' : 'Session submitted to the project queue', tone: 'ok' });
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
    if (!window.confirm(`End ${names[session.kind] ?? session.kind} session ${session.id}?`)) return;
    setBusy(session.id); setError(undefined);
    try {
      const ended = await api<PublicSession>(`/api/sessions/${session.id}`, { method: 'DELETE' });
      setToast({ message: ended.status === 'CLOSED' ? 'Session ended' : 'Access revoked; waiting for resources to terminate', tone: 'ok' });
      await sessions.refetch();
    } catch (err) { setError(err); await sessions.refetch(); } finally { setBusy(undefined); }
  }
  async function extend() {
    if (!extending) return;
    setBusy(extending.id); setError(undefined);
    try {
      await api(`/api/sessions/${extending.id}`, { method: 'PATCH', json: { ttlMinutes: extendMinutes } });
      setExtending(undefined); await sessions.refetch();
      setToast({ message: 'Expiry extended. Open the session again to refresh its connection.', tone: 'ok' });
    } catch (err) { setError(err); } finally { setBusy(undefined); }
  }
  const canCreate = !!project && (!attached || !!workflowId && !!taskName && !!selectedReplica && (kind !== 'port-forward' || selectedReplica.ports.includes(portName))) && (kind !== 'tensorboard' || !!logDir) && ttlMinutes >= 5 && ttlMinutes <= 1440;
  const liveCount = sessions.data?.filter((s) => s.status !== 'CLOSED').length ?? 0;
  return <>
    <PageHeader title="시뮬레이션·개발 세션" />
    {me.data?.role === 'admin' && <DcvBrowserCard />}
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <p className="max-w-2xl text-sm text-fg-muted">Open a personal research workspace or connect to one of your running tasks. Workspaces use your project queue and close when their time expires.</p>
      {can(me.data, 'researcher') && <Button variant="primary" onClick={() => { setShowCreate(true); setError(undefined); }}>New session</Button>}
    </div>
    {(error || sessions.error || me.error) && <ErrorBox error={error ?? sessions.error ?? me.error} />}
    {sessions.isLoading && <Spinner label="Loading sessions…" />}
    <Card title="Development sessions" description={`${liveCount} active · ${sessions.data?.length ?? 0} total`}>
      {!sessions.data?.length ? <EmptyState title="No development sessions" hint="Create JupyterLab, VS Code or TensorBoard, or attach a terminal to a running task." />
        : <Table head={['Session', 'Project / queue', 'Readiness', 'Expires', 'Actions']} dense>
          {sessions.data.map((s) => {
            const expired = !!s.expiresAt && Date.parse(s.expiresAt) <= clock;
            return <tr key={s.id}>
              <td><div className="font-medium">{names[s.kind] ?? s.kind}</div><div className="mt-1 font-mono text-[11px] text-fg-muted">{s.id}</div>
                <div className="mt-1 text-xs text-fg-muted">{s.taskName ? `${s.taskName} · attempt ${s.attempt} · replica ${s.replicaIndex ?? 0}` : s.owner}</div></td>
              <td><div className="text-sm">{projects.data?.find((p) => p.id === s.projectId)?.name ?? s.projectId ?? 'Legacy'}</div>
                <div className="mt-1 max-w-56 truncate text-xs text-fg-muted" title={s.queue}>{s.queue ?? s.namespace}</div></td>
              <td><StatusPill status={s.status} />{s.message && <p className="mt-1 max-w-64 text-xs text-fg-muted">{s.message}</p>}</td>
              <td className="text-xs"><div>{s.expiresAt ? fmtTime(s.expiresAt) : 'No managed expiry'}</div>
                <div className="mt-1 text-fg-muted">{s.status === 'CLOSED' ? 'Closed' : expired ? 'Expired · cleanup pending' : s.expiresAt ? `${Math.max(0, Math.ceil((Date.parse(s.expiresAt) - clock) / 60000))} min remaining` : 'End and recreate to launch'}</div></td>
              <td><div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => open(s)} disabled={!s.canOpen || expired || !!busy}>Open</Button>
                {s.canExtend && <Button size="sm" onClick={() => { setExtending(s); setExtendMinutes(Math.min(1440, Math.ceil((Date.parse(s.expiresAt!) - clock) / 60000) + 60)); }} disabled={expired || !!busy}>Extend</Button>}
                {s.canEnd && <Button size="sm" variant="danger" onClick={() => end(s)} disabled={!!busy}>End</Button>}
              </div></td>
            </tr>;
          })}
        </Table>}
    </Card>
    <Dialog title="New development session" open={showCreate} onClose={() => !busy && setShowCreate(false)} footer={<>
      <Button onClick={() => setShowCreate(false)} disabled={!!busy}>Cancel</Button><Button variant="primary" onClick={create} disabled={!canCreate || !!busy} loading={busy === 'create'}>Create session</Button>
    </>}>
      <div className="space-y-4">
        {Boolean(error) && <ErrorBox error={error} />}{projects.error && <ErrorBox error={projects.error} />}
        <label className="block text-sm">Project<Select className="mt-1" value={projectId} onChange={(e) => changeProject(e.target.value)}>
          <option value="">Select your project</option>{eligibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select></label>
        {!eligibleProjects.length && <p className="text-xs text-fg-muted">Ask a project administrator to add your Cognito subject as a researcher.</p>}
        {project && <p className="text-xs text-fg-muted">Queue: {project.queue}</p>}
        <label className="block text-sm">Application<Select className="mt-1" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPortName(''); }}>
          {Object.entries(names).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </Select></label>
        {kind === 'tensorboard' && <label className="block text-sm">Project log directory<Input className="mt-1" value={logDir} onChange={(e) => setLogDir(e.target.value)} placeholder={`/fsx/checkpoints/projects/${projectId || 'project'}/runs/…`} />
          <span className="mt-1 block text-xs text-fg-muted">Choose an existing run directory in this project. Logs are mounted read-only.</span></label>}
        {attached && <>
          {workflows.error && <ErrorBox error={workflows.error} />}
          <label className="block text-sm">Your running workflow<Select className="mt-1" value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setTaskName(''); setPortName(''); }}>
            <option value="">Select workflow</option>{ownWorkflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.name} · {wf.id}</option>)}
          </Select></label>
          {!ownWorkflows.length && <p className="text-xs text-fg-muted">No workflow you own is running in this project.</p>}
          {tasks.error && <ErrorBox error={tasks.error} />}
          <label className="block text-sm">Running task<Select className="mt-1" value={taskName} onChange={(e) => { setTaskName(e.target.value); setPortName(''); }}>
            <option value="">Select task</option>{tasks.data?.tasks.filter((t) => t.phase === 'RUNNING').map((t) => <option key={t.name} value={t.name}>{t.name} · attempt {t.attempts}</option>)}
          </Select></label>
          {connection.error && <ErrorBox error={connection.error} />}
          <label className="block text-sm">Ready replica<Select className="mt-1" value={replicaIndex} onChange={(e) => { setReplicaIndex(Number(e.target.value)); setPortName(''); }}>
            {replicas.map((r) => <option key={r.replicaIndex} value={r.replicaIndex}>Replica {r.replicaIndex}</option>)}
          </Select></label>
          {taskName && !connection.isLoading && !replicas.length && <p className="text-xs text-fg-muted">No ready pod for the current attempt. Refresh after the task starts.</p>}
          {kind === 'port-forward' && <label className="block text-sm">Registered application port<Select className="mt-1" value={portName} onChange={(e) => setPortName(e.target.value)}>
            <option value="">Select named port</option>{selectedReplica?.ports.map((port) => <option key={port} value={port}>{port}</option>)}
          </Select><span className="mt-1 block text-xs text-fg-muted">Only named TCP ports declared on the task container can be opened.</span></label>}
        </>}
        <label className="block text-sm">Time limit (minutes)<Input className="mt-1" type="number" min={5} max={1440} value={ttlMinutes} onChange={(e) => setTtlMinutes(Number(e.target.value))} /></label>
      </div>
    </Dialog>
    <Dialog title="Extend session" open={!!extending} onClose={() => !busy && setExtending(undefined)} footer={<>
      <Button onClick={() => setExtending(undefined)} disabled={!!busy}>Cancel</Button><Button variant="primary" onClick={extend} disabled={!!busy}>Save expiry</Button>
    </>}>
      {Boolean(error) && <ErrorBox error={error} />}
      <label className="block text-sm">Minutes from now<Input className="mt-2" type="number" min={5} max={1440} value={extendMinutes} onChange={(e) => setExtendMinutes(Number(e.target.value))} /></label>
      <p className="mt-3 text-xs text-fg-muted">Sessions have a 24-hour maximum lifetime. Reopen after extending to refresh the authenticated connection.</p>
    </Dialog>
    {profile?.role === 'admin' && <div className="mt-6"><AdminDcvPanel /></div>}
    {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(undefined)} />}
  </>;
}

interface DcvWorkstation { instanceId: string; state: string; instanceType?: string; launchTime?: string; dcvUrl?: string; codeServerUrl?: string; hasSecret: boolean }
interface DcvNode { cluster: string; orchestrator: string; group: string; instanceId: string; instanceType: string; status: string; portForward: string; login: string }
function AdminDcvPanel() {
  const dcv = useApi<{ workstation?: DcvWorkstation | { error: string }; nodes: DcvNode[] }>('/api/sessions/dcv', { refetch: 10000 });
  const [error, setError] = React.useState<unknown>(), [busy, setBusy] = React.useState(false);
  const [credentials, setCredentials] = React.useState<{ username: string; password: string }>();
  React.useEffect(() => { if (!credentials) return; const timer = setTimeout(() => setCredentials(undefined), 60000); return () => clearTimeout(timer); }, [credentials]);
  const ws = dcv.data?.workstation && !('error' in dcv.data.workstation) ? dcv.data.workstation : undefined;
  async function action(name: 'start' | 'stop' | 'credentials') {
    if (name === 'stop' && !window.confirm('Stop the workstation and disconnect active desktop users?')) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api<{ username: string; password: string }>(`/api/sessions/dcv/${name}`, { method: 'POST' });
      if (name === 'credentials') setCredentials(result); else await dcv.refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title="Existing workstation / DCV administration" description="Administrator access · managed DCV session integration is configured separately">
    {(error || dcv.error) && <ErrorBox error={error ?? dcv.error} />}
    {dcv.data?.workstation && 'error' in dcv.data.workstation && <ErrorBox error={new Error(dcv.data.workstation.error)} />}
    {dcv.isLoading && <Spinner label="Loading workstation…" />}
    {ws && <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><StatusPill status={ws.state} /><span className="font-mono text-xs">{ws.instanceId} · {ws.instanceType}</span>{ws.launchTime && <span className="text-xs text-fg-muted">Started {ago(ws.launchTime)}</span>}</div>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => action(ws.state === 'stopped' ? 'start' : 'stop')}>{ws.state === 'stopped' ? 'Start workstation' : 'Stop workstation'}</Button>
        {ws.dcvUrl && <Button onClick={() => window.open(ws.dcvUrl, '_blank', 'noopener,noreferrer')}>Open DCV</Button>}
        {ws.codeServerUrl && <Button onClick={() => window.open(ws.codeServerUrl, '_blank', 'noopener,noreferrer')}>Open workstation editor</Button>}
        {ws.hasSecret && <Button disabled={busy} onClick={() => action('credentials')}>Reveal credentials</Button>}
      </div></div>}
    {credentials && <div className="mt-4 rounded border border-border p-3"><p className="mb-2 text-xs text-fg-muted">Hidden automatically after 60 seconds</p>
      <div className="flex items-center gap-2"><code>{credentials.username}</code><CopyButton text={credentials.username} /></div>
      <div className="flex items-center gap-2"><code>{credentials.password}</code><CopyButton text={credentials.password} /></div><Button size="sm" onClick={() => setCredentials(undefined)}>Hide</Button>
    </div>}
    {!!dcv.data?.nodes.length && <details className="mt-5"><summary className="cursor-pointer text-sm">Existing HyperPod node access</summary>
      {dcv.data.nodes.map((node) => <div className="mt-3" key={`${node.cluster}-${node.instanceId}`}><div className="mb-2 flex items-center gap-2"><Badge>{node.orchestrator}</Badge><span className="text-xs">{node.instanceId} · {node.instanceType}</span></div>
        <CodeBlock code={node.portForward} lang="bash" /><p className="mt-1 text-xs text-fg-muted">Login: {node.login}</p></div>)}
    </details>}
  </Card>;
}
