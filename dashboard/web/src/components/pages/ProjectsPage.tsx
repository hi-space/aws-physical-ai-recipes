'use client';
import * as React from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { adoptableQuotas, backendAvailable, backendStatus, quotaLabel, type BackendRegistry, type ProjectRow, type QuotaRow } from './backend-ui';

interface Member { username: string; subject?: string; email?: string; role: 'viewer' | 'researcher' | 'project-admin' }
const tone = (attachment: ProjectRow['attachment']) => attachment === 'ATTACHED' ? 'ok' : attachment === 'DETACHED' ? 'warn' : 'neutral';

export function ProjectsPage() {
  const t = useT('projects');
  const tc = useT('common');
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const projects = useApi<ProjectRow[]>('/api/projects');
  const backends = useApi<BackendRegistry>(isAdmin ? '/api/backends' : null, { refetch: 15000 });
  const [backendId, setBackendId] = React.useState('default');
  const [quotaId, setQuotaId] = React.useState('');
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('backendId'), quota = params.get('quota');
    if (requested && /^[a-z][a-z0-9-]{0,39}$/.test(requested)) setBackendId(requested);
    if (quota && /^[A-Za-z0-9-]{1,128}$/.test(quota)) setQuotaId(quota);
  }, []);
  const backendReady = !backends.error && backendAvailable(backends.data, backendId);
  const quotas = useApi<{ quotas: QuotaRow[] }>(isAdmin && backendReady ? `/api/quotas?backendId=${encodeURIComponent(backendId)}` : null, { refetch: 15000 });
  const [selected, setSelected] = React.useState<string>();
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [newMember, setNewMember] = React.useState('');
  const project = projects.data?.find((item) => item.id === selected);
  const canManage = !!project && (isAdmin || project.myRole === 'project-admin');
  const members = useApi<{ members: Member[] }>(canManage ? `/api/projects/${encodeURIComponent(project.id)}/members` : null);
  const candidates = quotas.error || projects.error ? [] : adoptableQuotas(backends.data, backendId, quotas.data?.quotas, projects.data ?? []);
  const canAdopt = isAdmin && backendReady && !!projects.data && !projects.error && !quotas.error && !quotas.isFetching && candidates.some((q) => q.ComputeQuotaId === quotaId) && !busy;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(undefined); setMessage('');
    try { await action(); setMessage(success); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const adopt = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!canAdopt) return;
    const form = event.currentTarget; const name = String(new FormData(form).get('name') ?? '').trim();
    void run(async () => {
      const created = await api<ProjectRow>('/api/projects', { method: 'POST', json: { computeQuotaId: quotaId, backendId, ...(name ? { name } : {}) } });
      form.reset(); setQuotaId(''); await projects.refetch(); setSelected(created.id);
    }, t('projectAdopted'));
  };
  const setRole = (username: string, role: 'member' | 'project-admin' | null) => project && run(async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(username)}`, { method: 'PUT', json: { role } });
    setNewMember(''); await members.refetch();
  }, t('membershipSaved'));
  const remove = () => project && run(async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    setConfirmDelete(false); setSelected(undefined); await projects.refetch();
  }, t('projectDeleted'));

  return <>
    <PageHeader title={t('title')} description={t('projectManagementHint')} />
    {message && <p role="status" className="mb-4 text-sm text-ok">{message}</p>}
    {(error || projects.error) && <ErrorBox error={error ?? projects.error} />}
    <ErrorBox error={me.error} />
    {projects.isLoading && <Spinner label={t('loadingProjects')} />}
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Card title={t('projectList')}>
        {!projects.data?.length && <EmptyState title={t('noProjects')} hint={isAdmin ? t('noAdoptableQuotas') : t('noProjectsHint')} />}
        <div className="space-y-2">{projects.data?.map((item) => <button key={item.id}
          className={`w-full rounded-lg border p-4 text-left ${selected === item.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}
          onClick={() => setSelected(item.id)}>
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{item.name}</span><Badge tone={tone(item.attachment)}>{t(item.attachment.toLowerCase() as 'attached' | 'detached' | 'unknown')}</Badge></div>
          <p className="mt-1 text-xs text-fg-muted">{item.description ?? item.id}</p>
          <p className="mt-3 truncate text-xs text-fg-faint">backend: {item.backendId ?? 'default'} · {t('team')}: {item.id} · {t('quotaId')}: {item.computeQuotaId}</p>
        </button>)}</div>
      </Card>
      <Card title={project ? `${project.name} · ${t('projectMembers')}` : t('projectMembers')}
        actions={project && isAdmin ? <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>{t('deleteProject')}</Button> : undefined}>
        {!project ? <EmptyState title={t('selectProjectPrompt')} /> : <>
          {project.attachment === 'DETACHED' && <p className="mb-3 text-xs text-warn">{t('detachedHint')}</p>}
          <dl className="mb-4 grid grid-cols-2 gap-2 text-xs text-fg-muted">
            <dt>{t('namespace')}</dt><dd className="mono">{project.namespace}</dd>
            <dt>{t('queue')}</dt><dd className="mono">{project.queue}</dd>
          </dl>
          {!canManage ? <p className="text-sm text-fg-muted">{t('notAdmin')}</p> : <>
            <p className="mb-4 text-xs text-fg-muted">{t('platformRoleHint')}</p>
            {members.isLoading && <Spinner label={tc('loading')} />}
            <ErrorBox error={members.error} />
            <div className="space-y-3">{members.data?.members.map((member) => <div key={member.username} className="flex items-center justify-between gap-4 rounded border border-border bg-bg p-3">
              <span className="min-w-0 text-sm"><span className="block truncate">{member.username}</span><span className="block truncate text-xs text-fg-muted">{member.email}</span></span>
              <select aria-label={`${member.username} ${t('role')}`} className="rounded border border-border bg-bg-elev px-2 py-1.5 text-xs" disabled={busy}
                value={member.role === 'project-admin' ? 'project-admin' : 'member'}
                onChange={(event) => void setRole(member.username, event.target.value === '' ? null : event.target.value as 'member' | 'project-admin')}>
                <option value="member">{t('memberRoleMember')}</option><option value="project-admin">{t('memberRoleAdmin')}</option><option value="">{t('memberRemove')}</option>
              </select>
            </div>)}</div>
            <form className="mt-4 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (newMember.trim()) void setRole(newMember.trim(), 'member'); }}>
              <label className="grow text-xs text-fg-muted">{t('addMemberUsername')}<input value={newMember} onChange={(event) => setNewMember(event.target.value)} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" /></label>
              <Button type="submit" variant="primary" disabled={busy || !newMember.trim()}>{t('addMember')}</Button>
            </form>
          </>}
        </>}
      </Card>
    </div>
    {isAdmin && <Card title={t('adoptTeam')} className="mt-5" actions={<LinkButton href="/backends" size="sm">{t('backends')}</LinkButton>}>
      <p className="mb-4 text-xs leading-5 text-fg-muted">{t('adoptTeamDesc')}</p>
      <form onSubmit={adopt} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs text-fg-muted">{t('runBackend')}<select name="backendId" value={backendId} disabled={busy || backends.isLoading || !!backends.error} required
          className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" onChange={(event) => { setBackendId(event.target.value); setQuotaId(''); setError(undefined); setMessage(''); }}>
          <option value="default" disabled={!backends.data?.default?.configured}>{t('defaultEks')}</option>
          {backends.data?.backends?.map((row) => <option key={row.id} value={row.id} disabled={!backendAvailable(backends.data, row.id)}>{row.id} · {backendStatus(row.status).label}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">{t('team')}<select name="computeQuotaId" value={quotaId} onChange={(event) => setQuotaId(event.target.value)} disabled={busy || !backendReady || quotas.isFetching || !!quotas.error || !!projects.error} required className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm">
          <option value="">{t('teamSelect')}</option>{candidates.map((q) => <option key={q.ComputeQuotaId} value={q.ComputeQuotaId}>{quotaLabel(q)}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">{t('projectName')}<input name="name" maxLength={100} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder={candidates.find((q) => q.ComputeQuotaId === quotaId)?.ComputeQuotaTarget?.TeamName ?? ''} /></label>
        <Button type="submit" loading={busy} disabled={!canAdopt} variant="primary">{t('adopt')}</Button>
      </form>
      <ErrorBox error={backends.error} /><ErrorBox error={quotas.error} />
      {backends.isLoading && <Spinner label={t('selectBackend')} />}
      {!backends.isLoading && !backends.error && !backendReady && <p className="mt-3 text-sm text-fg-muted">{t('backendUnready')}</p>}
      {quotas.isFetching && <Spinner label={t('fetchingQuotas')} />}
      {backendReady && !quotas.isFetching && !quotas.error && !projects.error && quotas.data && candidates.length === 0 && <p className="mt-3 text-sm text-fg-muted">{t('noAdoptableQuotas')}</p>}
    </Card>}
    {confirmDelete && project && <Dialog open onClose={() => setConfirmDelete(false)} title={t('deleteProject')}>
      <p className="text-sm">{t('deleteConfirm')}</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirmDelete(false)}>{tc('cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void remove()}>{tc('delete')}</Button></div>
    </Dialog>}
  </>;
}
