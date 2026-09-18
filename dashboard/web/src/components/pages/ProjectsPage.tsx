'use client';
import * as React from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { backendAvailable, backendStatus, projectQueues, type BackendRegistry, type BackendQueue } from './backend-ui';

type Role = 'viewer' | 'researcher' | 'project-admin';
interface Project { id: string; name: string; namespace: string; queue: string; backendId?: string; members: Record<string, Role>; description?: string }
interface User { username: string; subject?: string; email?: string }

export function ProjectsPage() {
  const t = useT('projects');
  const tc = useT('common');
  const me = useMe();
  const projects = useApi<Project[]>('/api/projects');
  const users = useApi<{ users: User[] }>(me.data?.role === 'admin' ? '/api/admin/users' : null);
  const backends = useApi<BackendRegistry>(me.data?.role === 'admin' ? '/api/backends' : null, { refetch: 15000 });
  const [backendId, setBackendId] = React.useState('default');
  const [namespace, setNamespace] = React.useState('');
  React.useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('backendId');
    if (requested && /^[a-z][a-z0-9-]{0,39}$/.test(requested)) { setBackendId(requested); setNamespace(''); }
  }, []);
  const backendReady = !backends.error && backendAvailable(backends.data, backendId);
  const queues = useApi<{ localQueues: BackendQueue[] }>(me.data?.role === 'admin' && backendReady ? `/api/queues?backendId=${encodeURIComponent(backendId)}` : null, { refetch: 15000 });
  const [selected, setSelected] = React.useState<string>();
  const [members, setMembers] = React.useState<Record<string, Role>>({});
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const project = projects.data?.find((item) => item.id === selected);
  const availableQueues = queues.error || projects.error ? [] : projectQueues(backends.data, backendId, queues.data?.localQueues, projects.data ?? []);
  const canCreate = me.data?.role === 'admin' && backendReady && !!projects.data && !projects.error && !queues.error && !queues.isFetching && availableQueues.some(queue => queue.namespace === namespace) && !busy;

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(undefined); setMessage('');
    try {
      const created = await api<Project>('/api/projects', { method: 'POST', json: { id: data.get('id'), name: data.get('name'), namespace, backendId, members: {} } });
      if (created?.id !== data.get('id') || created.namespace !== namespace || (created.backendId ?? 'default') !== backendId) throw new Error(t('selectBackend'));
      form.reset(); setNamespace(''); await projects.refetch(); setMessage(t('projectCreated'));
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function saveMembers() {
    if (!project) return;
    setBusy(true); setError(undefined); setMessage('');
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', json: { members } });
      await projects.refetch(); setMessage(t('membersSaved'));
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return <>
    <PageHeader title={t('title')} description={t('projectManagementHint')} />
    {message && <p role="status" className="mb-4 text-sm text-ok">{message}</p>}
    {(error || projects.error) && <ErrorBox error={error ?? projects.error} />}
    <ErrorBox error={me.error} />
    {projects.isLoading && <Spinner label={t('loadingProjects')} />}
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Card title={t('projectList')}>
        {!projects.data?.length && <EmptyState title={t('noProjects')} hint={t('noProjectsHint')} />}
        <div className="space-y-2">{projects.data?.map((item) => <button key={item.id}
          className={`w-full rounded-lg border p-4 text-left ${selected === item.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}
          onClick={() => { setSelected(item.id); setMembers(item.members); }}>
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{item.name}</span><Badge>{t('members', { count: Object.keys(item.members).length })}</Badge></div>
          <p className="mt-1 text-xs text-fg-muted">{item.description ?? item.id}</p>
          <p className="mt-3 truncate text-xs text-fg-faint">backend: {item.backendId ?? 'default'} · {t('resourcePool')}: {item.namespace.replace('hyperpod-ns-', '')}</p>
        </button>)}</div>
      </Card>
      <Card title={project ? `${project.name} ${t('projectMembers').split(' ')[1]}` : t('projectMembers')}>
        {!project ? <EmptyState title={t('selectProjectPrompt')} /> : me.data?.role !== 'admin'
          ? <p className="text-sm text-fg-muted">{t('notAdmin')}</p>
          : <>
            <p className="mb-4 text-xs text-fg-muted">{t('memberManagement')}</p>
            <div className="space-y-3">{users.data?.users.map((user) => user.subject && <label key={user.subject} className="flex items-center justify-between gap-4 rounded border border-border bg-bg p-3">
              <span className="min-w-0 text-sm"><span className="block truncate">{user.username}</span><span className="block truncate text-xs text-fg-muted">{user.email}</span></span>
              <select aria-label={`${user.username} ${t('role')}`} className="rounded border border-border bg-bg-elev px-2 py-1.5 text-xs"
                value={members[user.subject] ?? ''} onChange={(event) => setMembers((current) => {
                  const next = { ...current }; if (event.target.value) next[user.subject!] = event.target.value as Role; else delete next[user.subject!]; return next;
                })}>
                <option value="">{t('noRole')}</option><option value="viewer">{t('viewer')}</option><option value="researcher">{t('researcher')}</option><option value="project-admin">{t('projectAdmin')}</option>
              </select>
            </label>)}</div>
            {users.error && <ErrorBox error={users.error} />}
            <Button className="mt-4" variant="primary" onClick={saveMembers} loading={busy}>{tc('save')}</Button>
          </>}
      </Card>
    </div>
    {me.data?.role === 'admin' && <Card title={t('newProject')} className="mt-5" actions={<LinkButton href="/backends" size="sm">{t('backends')}</LinkButton>}>
      <p className="mb-4 text-xs leading-5 text-fg-muted">{t('newProjectDesc')}</p>
      <form onSubmit={create} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-5">
        <label className="text-xs text-fg-muted">{t('projectName')}<input name="name" required maxLength={100} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder="Robot arm policy research" /></label>
        <label className="text-xs text-fg-muted">{t('projectId')}<input name="id" required pattern="[a-z][a-z0-9-]{0,39}" disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder="robot-arm" /></label>
        <label className="text-xs text-fg-muted">{t('runBackend')}<select name="backendId" value={backendId} disabled={busy || backends.isLoading || !!backends.error} required
          className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" onChange={event => { setBackendId(event.target.value); setNamespace(''); setError(undefined); setMessage(''); }}>
          <option value="default" disabled={!backends.data?.default?.configured}>{t('defaultEks')}</option>
          {backends.data?.backends?.map(row => <option key={row.id} value={row.id} disabled={!backendAvailable(backends.data, row.id)}>{row.id} · {backendStatus(row.status).label}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">{t('resourcePool')}<select name="namespace" value={namespace} onChange={event => setNamespace(event.target.value)} disabled={busy || !backendReady || queues.isFetching || !!queues.error || !!projects.error} required className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm">
          <option value="">{t('poolSelect')}</option>{availableQueues.map(queue => <option key={queue.namespace} value={queue.namespace}>{queue.namespace.replace('hyperpod-ns-', '')}</option>)}
        </select></label>
        <Button type="submit" loading={busy} disabled={!canCreate} variant="primary">{t('createProject')}</Button>
      </form>
      <ErrorBox error={backends.error} /><ErrorBox error={queues.error} />
      {backends.isLoading && <Spinner label={t('selectBackend')} />}
      {!backends.isLoading && !backends.error && !backendReady && <p className="mt-3 text-sm text-fg-muted">{t('backendUnready')}</p>}
      {queues.isFetching && <Spinner label={t('fetchingQueues')} />}
      {backendReady && !queues.isFetching && !queues.error && !projects.error && queues.data && availableQueues.length === 0 && <p className="mt-3 text-sm text-fg-muted">{t('noQueues')}</p>}
    </Card>}
  </>;
}
