'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Select, Spinner, Stat, Table } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { useT } from '@/lib/i18n';
import { useFormat } from '@/lib/i18n';
import { usageNumber } from '@/components/usage/UsageSummary';
import type { projectUsage } from '@/server/services/usage';
type ProjectUsage = Awaited<ReturnType<typeof projectUsage>>;
export function UsagePage() {
  const t = useT('usage');
  const tc = useT('common');
  const { fmtNum } = useFormat();
  const me = useMe(), projects = useApi<Array<{ id: string; name: string }>>('/api/projects');
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('projectId');
    if (id) setSelected(id);
  }, []);
  const projectId = selected ?? me.data?.project?.id ?? projects.data?.[0]?.id;
  const query = useApi<ProjectUsage>(projectId ? `/api/usage?projectId=${encodeURIComponent(projectId)}` : null, { refetch: 30000 });
  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')} />
    <ResourceStrip source={t('resourceSource')} items={[]} />
    <ErrorBox error={me.error} /><ErrorBox error={projects.error} /><ErrorBox error={query.error} />
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('project')}><Select value={projectId ?? ''} onChange={event => setSelected(event.target.value)}>
        <option value="" disabled>{t('selectProject')}</option>{projects.data?.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
      </Select></Field>
      <Button disabled={query.isFetching || !projectId} onClick={() => void query.refetch()}>{t('refreshUsage')}</Button>
    </div>
    {(query.isLoading || projects.isLoading) && <Spinner label={t('loading')} />}
    {!projects.isLoading && !projects.error && !projects.data?.length && <EmptyState title={t('noProjects')} />}
    {query.data && <Card title={`${query.data.project.name} · ${query.data.runs.length} ${t('runsCount')}`}>
      {!query.data.runs.length ? <EmptyState title={t('noRuns')} hint={t('noRunsHint')} /> : <>
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <Stat label={t('cpuHours')} value={usageNumber(query.data.cpuHours, t('unknown'), fmtNum)} />
          <Stat label={t('gpuHours')} value={usageNumber(query.data.gpuHours, t('unknown'), fmtNum)} />
        </div>
        <p className="mb-3 text-xs text-fg-muted">{t('caveat')}</p>
        <p className="mb-3 text-xs text-fg-muted">{query.data.discoveryBasis}</p>
        {!query.data.complete && <p className="mb-3 text-sm text-warn">{t('incomplete')}</p>}
        <Table head={[tc('name'), 'backend', 'CPU-hours', 'GPU-hours', t('status')]} dense>
          {query.data.runs.map(run => <tr key={run.workflowId}>
            <td><Link href={`/workflows/${encodeURIComponent(run.workflowId)}`} className="underline">{run.name ?? run.workflowId}</Link></td>
            <td>{run.backendId}</td><td>{usageNumber(run.cpuHours, t('unknown'), fmtNum)}</td><td>{usageNumber(run.gpuHours, t('unknown'), fmtNum)}</td>
            <td><Badge tone={run.complete ? 'info' : 'warn'}>{run.complete ? t('complete') : t('incomplete')}</Badge></td>
          </tr>)}
        </Table>
      </>}
    </Card>}
  </div>;
}
