'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, can, useApi, useMe } from '@/lib/api-client';
import { Bar, Button, Card, Dialog, EmptyState, ErrorBox, Input, LinkButton, Select, StatusPill } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { useT, useFormat } from '@/lib/i18n';
import type { Workflow } from '@/server/store/types';

export function WorkflowsPage() {
  const t = useT('workflows');
  const tr = useT('resources');
  const tc = useT('common');
  const { ago, fmtDuration } = useFormat();
  const me = useMe();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{ action: 'cancel' | 'delete'; ids: string[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCursor(undefined); setHistory([]); setSelected([]); }, [query, status]);
  const params = new URLSearchParams({ page: '1', status, q: query });
  if (cursor) params.set('cursor', cursor);
  const page = useApi<{ items: Workflow[]; cursor?: string }>(`/api/workflows?${params}`, { refetch: 5000 });
  const workflows = page.data?.items ?? [];
  const canWrite = can(me.data, 'researcher') && (me.data?.role === 'admin' || me.data?.project?.role !== 'viewer');
  const owns = (workflow: Workflow) => me.data?.role === 'admin' || (workflow.ownerSubject ? workflow.ownerSubject === me.data?.subject : workflow.owner === me.data?.user);
  const active = (workflow: Workflow) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(workflow.status);
  async function apply() {
    if (!confirmation) return;
    setBusy(true); setError(undefined);
    try {
      if (confirmation.action === 'cancel') {
        const result = await api<{ requested: string[]; failed: string[] }>('/api/workflows/bulk-cancel', { method: 'POST', json: { ids: confirmation.ids } });
        setNotice(t('cancelSuccess', { count: result.requested.length, failed: result.failed.length }));
      } else {
        await api(`/api/workflows/${confirmation.ids[0]}`, { method: 'DELETE' });
        setNotice(t('deleteSuccess'));
      }
      setConfirmation(undefined); setSelected([]); await page.refetch();
    } catch (value) { setError(value); } finally { setBusy(false); }
  }
  async function retry(workflow: Workflow) {
    setError(undefined);
    try {
      const result = await api<{ id: string }>(`/api/workflows/${workflow.id}/retry`, { method: 'POST' });
      window.location.href = `/workflows/${result.id}`;
    } catch (value) { setError(value); }
  }
  const res = me.data?.resources;
  return <div className="space-y-5">
    <PageHeader title={t('title')} actions={canWrite && <div className="flex gap-2">
      <LinkButton href="/workflows/compose" variant="secondary">{t('directAssembly')}</LinkButton>
      <LinkButton href="/workflows/new" variant="primary">{t('newRun')}</LinkButton>
    </div>} />
    <ResourceStrip
      source={t('resourceSource')}
      items={[
        { label: tr('hyperPodCluster'), value: res?.hyperPodEks?.clusterName, console: res?.hyperPodEks ? { kind: 'hyperpod-cluster', name: res.hyperPodEks.clusterName } : undefined, href: '/compute' },
        { label: tr('eksCluster'), value: res?.hyperPodEks?.eksClusterName, console: res?.hyperPodEks ? { kind: 'eks-cluster', name: res.hyperPodEks.eksClusterName } : undefined },
        { label: tr('namespace'), value: me.data?.defaultNamespace },
        { label: tr('serviceAccount'), value: res?.workflowServiceAccount },
        { label: tr('dataBucket'), value: res?.dataBucket, console: res?.dataBucket ? { kind: 's3-bucket', bucket: res.dataBucket } : undefined, href: '/datasets' },
      ]}
    />
    <p className="text-sm text-fg-muted">{t('description')}</p>
    {(error || page.error) && <ErrorBox error={error ?? page.error} />}
    {notice && <p role="status" className="text-sm text-info">{notice}</p>}
    <div className="flex flex-wrap gap-3">
      <label className="block max-w-md">
        <span className="sr-only">{t('searchPlaceholder')}</span>
        <Input className="max-w-md" value={search} placeholder={t('searchPlaceholder')} onChange={(event) => setSearch(event.target.value)} />
        {(page.data as { scanLimited?: boolean } | undefined)?.scanLimited && <span role="status" className="mt-1 block text-xs text-fg-muted">{t('searchLimited')}</span>}
      </label>
      <Select className="max-w-48" aria-label={t('title')} value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">{t('allStatus')}</option>
        <option value="PENDING">{tc('stPending')}</option>
        <option value="RUNNING">{tc('stRunning')}</option>
        <option value="FINALIZING">{tc('stFinalizing')}</option>
        <option value="SUCCEEDED">{tc('stSucceeded')}</option>
        <option value="FAILED">{tc('stFailed')}</option>
        <option value="CANCELLING">{tc('stCancelling')}</option>
        <option value="CANCELLED">{tc('stCancelled')}</option>
      </Select>
      {canWrite && selected.length > 0 && <Button variant="danger" onClick={() => setConfirmation({ action: 'cancel', ids: selected })}>{t('selectCancel', { count: selected.length })}</Button>}
    </div>
    <Card padded={false}>
      {!workflows.length ? <div className="p-5"><EmptyState title={page.isLoading ? t('loadingList') : t('nothingToShow')} hint={query || status ? t('noMatches') : t('startFirst')} /></div> : <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th aria-label={tc('select')} /><th>{t('colExperiment')}</th><th>{tc('status')}</th><th>{t('colProgress')}</th><th>{t('colOwner')}</th><th>{t('colStarted')}</th><th>{t('colDuration')}</th><th>{t('colActions')}</th></tr></thead>
        <tbody>{workflows.map((workflow) => <tr key={workflow.id}>
          <td>{canWrite && owns(workflow) && active(workflow) && <input type="checkbox" aria-label={`${workflow.name} ${tc('select')}`} checked={selected.includes(workflow.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, workflow.id] : current.filter((id) => id !== workflow.id))} />}</td>
          <td>
            <Link className="font-medium text-accent hover:underline" href={`/workflows/${workflow.id}`}>
              {workflow.name}
            </Link>
          </td>
          <td><StatusPill status={workflow.status} /></td>
          <td><div className="flex min-w-24 items-center gap-2"><Bar value={workflow.succeededCount} max={workflow.taskCount || 1} tone={workflow.failedCount ? 'err' : 'ok'} /><span className="text-xs">{workflow.succeededCount}/{workflow.taskCount}</span></div></td>
          <td className="text-xs">{workflow.owner}</td><td className="text-xs">{ago(workflow.createdAt)}</td>
          <td className="text-xs">{workflow.startedAt ? fmtDuration(Date.parse(workflow.finishedAt ?? new Date().toISOString()) - Date.parse(workflow.startedAt)) : '—'}</td>
          <td><div className="flex gap-1">
            {canWrite && owns(workflow) && active(workflow) && <Button size="sm" onClick={() => setConfirmation({ action: 'cancel', ids: [workflow.id] })}>{tc('stop')}</Button>}
            {canWrite && !active(workflow) && <Button size="sm" onClick={() => retry(workflow)}>{tc('retry')}</Button>}
            {canWrite && owns(workflow) && !active(workflow) && <Button size="sm" variant="ghost" onClick={() => setConfirmation({ action: 'delete', ids: [workflow.id] })}>{tc('delete')}</Button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </Card>
    <div className="flex items-center justify-between"><span className="text-xs text-fg-muted">{t('pageInfo', { page: history.length + 1 })}</span><div className="flex gap-2">
      <Button disabled={!history.length} onClick={() => { setCursor(history.at(-1)); setHistory((current) => current.slice(0, -1)); setSelected([]); }}>{tc('previous')}</Button>
      <Button disabled={!page.data?.cursor} onClick={() => { setHistory((current) => [...current, cursor]); setCursor(page.data?.cursor); setSelected([]); }}>{tc('next')}</Button>
    </div></div>
    <Dialog open={Boolean(confirmation)} onClose={() => setConfirmation(undefined)} title={confirmation?.action === 'cancel' ? t('confirmCancelTitle') : t('confirmDeleteTitle')} footer={<><Button onClick={() => setConfirmation(undefined)}>{tc('cancel')}</Button><Button variant="danger" loading={busy} onClick={apply}>{tc('confirm')}</Button></>}>
      {confirmation?.action === 'cancel' ? t('cancelMessage', { count: confirmation.ids.length }) : t('deleteMessage')}
    </Dialog>
  </div>;
}
