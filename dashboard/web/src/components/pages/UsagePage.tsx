'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Select, Spinner, Stat, Table } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { PricingBasis, usageNumber, usageUsd } from '@/components/usage/UsageSummary';
import type { projectUsage } from '@/server/services/usage';
type ProjectUsage = Awaited<ReturnType<typeof projectUsage>>;
export function UsagePage() {
  const t = useT('usage');
  const tc = useT('common');
  const me = useMe(), projects = useApi<Array<{ id: string; name: string }>>('/api/projects');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('projectId');
    if (id) setSelected(id);
  }, []);
  const projectId = selected ?? me.data?.project?.id ?? projects.data?.[0]?.id;
  const query = useApi<ProjectUsage>(projectId ? `/api/usage?projectId=${encodeURIComponent(projectId)}` : null, { refetch: 30000 });
  async function refreshRates() {
    setBusy(true); setError(undefined);
    try { await api('/api/usage/rates', { method: 'POST' }); await query.refetch(); }
    catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')} />
    <ErrorBox error={me.error} /><ErrorBox error={projects.error} /><ErrorBox error={query.error} /><ErrorBox error={error} />
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('project')}><Select value={projectId ?? ''} onChange={event => setSelected(event.target.value)}>
        <option value="" disabled>{t('selectProject')}</option>{projects.data?.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
      </Select></Field>
      <Button disabled={query.isFetching || !projectId} onClick={() => void query.refetch()}>{t('refreshUsage')}</Button>
      {me.data?.role === 'admin' && <Button disabled={busy} loading={busy} onClick={() => void refreshRates()}>{t('refreshRates')}</Button>}
    </div>
    {(query.isLoading || projects.isLoading) && <Spinner label={t('loading')} />}
    {!projects.isLoading && !projects.error && !projects.data?.length && <EmptyState title={t('noProjects')} />}
    {query.data && <Card title={`${query.data.project.name} · ${query.data.runs.length} ${t('runsCount')}`}>
      {!query.data.runs.length ? <EmptyState title={t('noRuns')} hint={t('noRunsHint')} /> : <>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Stat label={t('cpuHours')} value={usageNumber(query.data.cpuHours, t('unknown'))} />
          <Stat label={t('gpuHours')} value={usageNumber(query.data.gpuHours, t('unknown'))} />
          <Stat label={t('estimatedCost')} value={usageUsd(query.data.estimatedUsd, t('unknown'))} />
        </div>
        <p className="mb-3 text-xs text-fg-muted">{t('caveat')}</p>
        <p className="mb-3 text-xs text-fg-muted">{query.data.discoveryBasis}</p>
        {!query.data.complete && <p className="mb-3 text-sm text-warn">{t('incomplete')}</p>}
        <Table head={[tc('name'), 'backend', 'CPU-hours', 'GPU-hours', t('estimatedCost'), t('status')]} dense>
          {query.data.runs.map(run => <tr key={run.workflowId}>
            <td><Link href={`/workflows/${encodeURIComponent(run.workflowId)}`} className="underline">{run.name ?? run.workflowId}</Link></td>
            <td>{run.backendId}</td><td>{usageNumber(run.cpuHours, t('unknown'))}</td><td>{usageNumber(run.gpuHours, t('unknown'))}</td><td>{usageUsd(run.estimatedUsd, t('unknown'))}</td>
            <td><Badge tone={run.complete ? 'info' : 'warn'}>{run.complete ? t('complete') : t('incomplete')}</Badge></td>
          </tr>)}
        </Table>
      </>}
      <div className="mt-4"><PricingBasis pricing={query.data.pricing} /></div>
      <p className="mt-3 text-xs text-fg-muted">{t('disclamer')}</p>
    </Card>}
  </div>;
}
