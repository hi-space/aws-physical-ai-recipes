'use client';
import { useState } from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner, Table } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { backendStatus, registrationBody, type BackendRegistry, type BackendRevision, type BackendRow } from './backend-ui';

export function BackendsPage() {
  const t = useT('backends');
  const tc = useT('common');
  const me = useMe(), admin = me.data?.role === 'admin';
  const registry = useApi<BackendRegistry>(admin ? '/api/backends' : null, { refetch: 15000 });
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const current = registry.data?.backends?.find(row => row.id === selected);
  const detail = useApi<{ backend: BackendRow; revisions: BackendRevision[] }>(admin && current ? `/api/backends/${encodeURIComponent(current.id)}` : null);
  const registered = typeof current?.version === 'number' && current.version > 0;
  const canRegister = !!current?.profile && Number.isSafeInteger(current.version) && current.version! >= 0;

  async function change(action: 'register' | 'toggle' | 'check') {
    if (!admin || !current || busy || registry.error || !canRegister) return;
    setBusy(true); setError(undefined); setNotice('');
    try {
      const saved = action === 'check'
        ? await api<BackendRow>(`/api/backends/${encodeURIComponent(current.id)}/check`, { method: 'POST', json: { version: current.version } })
        : await api<BackendRow>('/api/backends', { method: 'POST', json: registrationBody(current, action === 'toggle' ? !current.enabled : true) });
      if (saved?.id !== current.id || !Number.isSafeInteger(saved.version) || saved.version! < 1 || !['READY', 'UNREADY', 'DISABLED'].includes(saved.status)) throw new Error(tc('errorLoad'));
      const refreshed = await registry.refetch(); await detail.refetch();
      if (refreshed.error) throw new Error(tc('errorLoad'));
      setNotice(t('notice', { id: current.id, version: saved.version, action: action === 'check' ? t('checkAction') : t('registerAction'), status: backendStatus(saved.status).label }));
    } catch (cause) {
      setError(cause);
      await registry.refetch();
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')}
      actions={admin ? <LinkButton href="/projects">{tc('name')}</LinkButton> : undefined} />
    <ErrorBox error={me.error} />
    {me.isLoading && <Spinner label={t('loadingAdmin')} />}
    {me.data && !admin && <EmptyState title={t('adminOnly')} hint={t('adminHint')} />}
    {admin && <>
      <ErrorBox error={registry.error} /><ErrorBox error={error} />
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {registry.isLoading && <Spinner label={t('loading')} />}
      <Card title={t('defaultEks')} actions={<Button size="sm" disabled={busy || registry.isFetching} onClick={() => void registry.refetch()}>{tc('refresh')}</Button>}>
        {registry.data?.default ? <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{registry.data.default.clusterName ?? t('noCluster')}</span>
          <Badge tone={registry.data.default.configured ? 'info' : 'warn'}>{registry.data.default.configured ? t('configured') : t('notConfigured')}</Badge>
          <span className="text-xs text-fg-muted">{t('defaultEksDesc')}</span>
        </div> : <p className="text-sm text-fg-muted">{tc('errorLoad')}</p>}
      </Card>
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <Card title={t('additionalEks')}>
          {!registry.isLoading && !registry.error && registry.data?.backends?.length === 0 && <EmptyState title={t('noAdditional')} hint={t('noAdditionalHint')} />}
          <div className="space-y-2">{registry.data?.backends?.map(row => {
            const status = backendStatus(row.status);
            return <button key={row.id} type="button" aria-pressed={selected === row.id} disabled={busy} onClick={() => { setSelected(row.id); setError(undefined); setNotice(''); }}
              className={`w-full rounded border p-3 text-left ${selected === row.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}>
              <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{row.id}</span><Badge tone={status.tone}>{status.label}</Badge></span>
              <span className="mt-2 block text-xs text-fg-muted">{row.profile?.eks.eksClusterName ?? tc('errorLoad')} · {row.version ? `${t('registered')} v${row.version}` : t('unregistered')}</span>
            </button>;
          })}</div>
        </Card>
        <Card title={current ? `${current.id} · ${t('connectionInfo')}` : t('connectionInfo')}>
          {!current ? <EmptyState title={t('selectBackend')} /> : <>
            <div className="mb-3 flex items-center gap-2"><Badge tone={backendStatus(current.status).tone}>{backendStatus(current.status).label}</Badge>
              <span className="text-xs text-fg-muted">{t('registered')} {current.version ? `v${current.version}` : t('unregistered')}{current.configVersion ? ` · Config v${current.configVersion}` : ''}</span></div>
            {current.profile && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-fg-muted">{t('supportScope')}</dt><dd>{current.profile.accountId} · {current.profile.region} · {current.profile.vpcId}</dd>
              <dt className="text-fg-muted">{t('eks')}</dt><dd className="break-all">{current.profile.eks.eksClusterName}</dd>
              <dt className="text-fg-muted">{t('storage')}</dt><dd className="break-all">{current.profile.eks.fsxFileSystemId ?? tc('notAvailable')} · {current.profile.eks.dataBucket ?? tc('notAvailable')}</dd>
              <dt className="text-fg-muted">{t('namespaces')}</dt><dd className="break-all">{current.profile.namespaces.join(', ') || t('none')}</dd>
            </dl>}
            <ul aria-label="Backend diagnostics" className="mt-4 space-y-2 text-sm">{current.findings.map((finding, index) => <li key={`${finding.code}:${index}`} className="rounded border border-border p-3">
              <code className="text-xs text-fg-muted">{finding.code}</code><p className="mt-1">{finding.message}</p>
            </li>)}</ul>
            {current.status !== 'READY' && current.findings.length === 0 && <p className="mt-3 text-sm text-fg-muted">{t('noFindings')}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {!registered ? <Button disabled={!canRegister || busy || !!registry.error} onClick={() => void change('register')} variant="primary">{t('register')}</Button>
                : <>
                  <Button disabled={busy || !canRegister || !!registry.error} variant={current.enabled ? 'danger' : 'secondary'} onClick={() => void change('toggle')}>{current.enabled ? t('toggleDisable') : t('toggleEnable')}</Button>
                  {current.findings.some(finding => finding.code === 'configuration_changed') && <Button disabled={busy || !!registry.error} onClick={() => void change('register')} variant="secondary">{t('registerNewVersion')}</Button>}
                  <Button disabled={busy || !current.enabled || !canRegister || !!registry.error} onClick={() => void change('check')} variant="secondary">{t('checkConnection')}</Button>
                </>}
              {current.status === 'READY' && current.enabled && <LinkButton href={`/projects?backendId=${encodeURIComponent(current.id)}`} variant="primary">{t('adoptTeamBtn')}</LinkButton>}
            </div>
            {busy && <Spinner label={t('processing')} />}
            <p className="mt-3 text-xs leading-5 text-fg-muted">{t('footerNote')}</p>
            <ErrorBox error={detail.error} />
            {!!detail.data?.revisions.length && <details className="mt-4">
              <summary className="cursor-pointer text-sm">{t('registrationHistory')}</summary>
              <Table head={[t('version'), t('enabled'), tc('created'), 'By']} dense><>{detail.data.revisions.map(revision => <tr key={revision.version}>
                <td>v{revision.version}</td><td>{revision.enabled ? t('enabled') : t('disabled')}</td><td>{revision.createdAt}</td><td>{revision.createdBy}</td>
              </tr>)}</></Table>
            </details>}
          </>}
        </Card>
      </div>
      <p className="text-xs leading-5 text-fg-muted">{t('limitations')}</p>
    </>}
  </div>;
}
