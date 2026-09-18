'use client';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Card, EmptyState, ErrorBox, LinkButton, Spinner, Stat, StatusPill, Table } from '@/components/ui';
import { Sparkline } from '@/components/charts/Sparkline';
import { useFormat, useT } from '@/lib/i18n';
import { useApi, useMe, can } from '@/lib/api-client';
import type { overview } from '@/server/services/overview';

// Type-only import: track the service DTO without bundling server code into the browser.
type OverviewData = Awaited<ReturnType<typeof overview>>;

export function OverviewPage() {
  const t = useT('overview');
  const tc = useT('common');
  const { ago, fmtNum, fmtUsd } = useFormat();
  const me = useMe();
  const { data, isLoading, error } = useApi<OverviewData>('/api/overview', { refetch: 15000 });

  if (isLoading && !data) return <><PageHeader title={t('title')} /><Spinner label={t('loading')} /></>;
  if (!data) return <><PageHeader title={t('title')} /><ErrorBox error={error ?? new Error(t('noData'))} /></>;

  const cost = can(me.data, 'admin') ? data.cost : undefined;
  const costDaily = (cost?.daily ?? []).map((day) => day.amount).filter(Number.isFinite);
  const costMax = Math.max(...(cost?.byService ?? []).map((service) => service.amount), 1);
  const serviceErrors = [...new Set([...data.errors, data.nodes.error].filter((message): message is string => Boolean(message)))];
  const nodeError = Boolean(data.nodes.error);
  const gpuAverage = !nodeError && data.nodes.gpuCapacity > 0 && Number.isFinite(data.nodes.gpuUtilAvg)
    ? t('gpuAverageSub', { value: fmtNum(data.nodes.gpuUtilAvg) }) : t('gpuAverageNa');
  const status = data.workflows.byStatus;
  const researcher = can(me.data, 'researcher');

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={researcher && <LinkButton href="/workflows/new" variant="primary">{t('newRun')}</LinkButton>}
      >
        {/* Quick links: the three-step research loop, plus the optional consoles this deployment has. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-faint">{t('quickStartHint')}</span>
          <LinkButton href="/datasets" size="sm">{t('manageDatasets')}</LinkButton>
          {data.features.pipeline && researcher && <LinkButton href="/pipelines" size="sm">{t('pipelines')}</LinkButton>}
          {data.features.mlflow && <LinkButton href="/experiments" size="sm">{t('experiments')}</LinkButton>}
          {data.features.dcv && <LinkButton href="/sessions" size="sm">{t('sessions')}</LinkButton>}
          {data.features.eks && <LinkButton href="/compute" size="sm">{t('compute')}</LinkButton>}
          {data.features.amp && <LinkButton href="/metrics" size="sm">{t('metrics')}</LinkButton>}
        </div>
      </PageHeader>
      <div className="space-y-5">
        {error && <div role="alert" className="space-y-2"><p className="text-sm text-fg-muted">{tc('errorStale')}</p><ErrorBox error={error} /></div>}
        {me.error && <ErrorBox error={me.error} />}
        {serviceErrors.length > 0 && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-fg-muted">{t('partialErrors')}</p>
            {serviceErrors.map((message) => <ErrorBox key={message} error={{ message }} />)}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t('statWorkflows')}
            value={fmtNum(data.workflows.total)}
            sub={t('statWorkflowsSub', { running: fmtNum(status.RUNNING ?? 0), pending: fmtNum(status.PENDING ?? 0), finalizing: fmtNum(status.FINALIZING ?? 0), cancelling: fmtNum(status.CANCELLING ?? 0) })}
          />
          {data.features.eks && (
            <>
              <Stat
                label={t('statGpu')}
                value={nodeError ? '—' : fmtNum(data.nodes.gpuAllocatable)}
                sub={nodeError ? t('nodeLookupFailed') : t('statGpuSub', { capacity: fmtNum(data.nodes.gpuCapacity), average: gpuAverage })}
                tone={nodeError ? 'err' : data.nodes.gpuAllocatable > 0 ? 'ok' : 'warn'}
              />
              <Stat
                label={t('statNodes')}
                value={nodeError ? '—' : `${data.nodes.ready}/${data.nodes.total}`}
                tone={nodeError ? 'err' : data.nodes.total > 0 && data.nodes.ready === data.nodes.total ? 'ok' : 'warn'}
              />
              <Stat
                label={t('statQueue')}
                value={fmtNum(data.queues.pendingWorkloads)}
                sub={t('statQueueSub', { admitted: fmtNum(data.queues.admitted) })}
                tone={data.queues.pendingWorkloads > 0 ? 'warn' : 'ok'}
              />
            </>
          )}
          {cost && <Stat label={t('accountCost')} value={fmtUsd(cost.total)} sub={t('accountCostSub')} />}
        </div>

        <Card title={t('recentRuns')} description={t('recentRunsDesc', { count: fmtNum(data.workflows.total) })} actions={<LinkButton href="/workflows" size="sm">{t('allRuns')}</LinkButton>} padded={false}>
          {!data.workflows.recent.length ? (
            <EmptyState title={t('noRuns')} hint={serviceErrors.length ? t('noRunsHintError') : t('noRunsHint')} action={researcher && <LinkButton href="/workflows/new" variant="primary" size="sm">{t('newRun')}</LinkButton>} />
          ) : (
            <Table head={[tc('name'), tc('status'), t('colUser'), t('colTasks'), t('colCreated')]}>
              {data.workflows.recent.map((workflow) => (
                <tr key={workflow.id}>
                  <td><Link href={`/workflows/${encodeURIComponent(workflow.id)}`} className="font-medium text-accent hover:underline">{workflow.name}</Link></td>
                  <td><StatusPill status={workflow.status} /></td>
                  <td className="text-fg-muted">{workflow.owner || '—'}</td>
                  <td className="num">{`${fmtNum(workflow.succeededCount)}/${fmtNum(workflow.taskCount)}`}</td>
                  <td className="text-fg-muted">{ago(workflow.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Card title={t('clusters')} description={t('clustersDesc', { count: data.clusters.length })}>
            {!data.clusters.length ? <EmptyState title={t('noClusters')} /> : (
              <div className="space-y-2">
                {data.clusters.map((cluster) => (
                  <div key={cluster.name} className="space-y-2 rounded-md border border-border bg-bg-elev-2 p-3">
                    <Link href="/compute" className="font-medium text-accent hover:underline">{cluster.name}</Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="info">{cluster.orchestrator}</Badge>
                      {cluster.status && !cluster.status.startsWith('error:') && <StatusPill status={cluster.status} />}
                      {cluster.groups.map((group) => {
                        const gpuCount = group.gpuCount ?? (group.isGpu ? 1 : 0);
                        const gpuBadge = gpuCount > 0 ? <Badge tone="accent">{t('gpuBadge', { count: gpuCount })}</Badge> : gpuCount === 0 ? null : <Badge tone="neutral">?</Badge>;
                        return (
                          <span key={group.name} className="text-[13px] text-fg-muted flex items-center gap-1">
                            <Badge tone="neutral">{group.name}</Badge> {t('groupCounts', { current: group.current, target: group.target })} {gpuBadge}
                          </span>
                        );
                      })}
                    </div>
                    {cluster.status?.startsWith('error:') && <ErrorBox error={{ message: cluster.status }} />}
                    {'failureMessage' in cluster && cluster.failureMessage && <ErrorBox error={{ message: cluster.failureMessage }} />}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={t('recentEvents')} description={t('recentEventsDesc')}>
            {!data.recentEvents.length ? <EmptyState title={t('noEvents')} /> : (
              <div className="space-y-2">
                {data.recentEvents.map((event, index) => (
                  <div key={`${event.ts}-${index}`} className="flex items-start gap-3 border-l-2 border-border px-3 py-2 text-[13px]">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-fg">{event.workflowName} <span className="text-fg-muted">· {event.reason}</span></div>
                      <div className="mt-1 text-fg-muted">{event.message}</div>
                    </div>
                    <div className="shrink-0 text-xs text-fg-faint">{ago(event.ts)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {cost && (
          <Card title={t('accountCost')}>
            <div className="mb-4 text-xs text-fg-muted space-y-0.5">
              <div>{t('costExplorer')} · {t('fetchedAt', { time: cost.fetchedAt ? ago(new Date(cost.fetchedAt)) : '—' })}</div>
              <div>{t('costPeriod', { start: cost.start, end: cost.end })}</div>
              {cost.estimated && <div className="text-accent">{t('costEstimated')}</div>}
            </div>
            {costDaily.length > 0 && <div className="mb-4" aria-label={t('costTrend')}><Sparkline values={costDaily} width={240} height={36} /></div>}
            {!cost.byService.length ? <EmptyState title={t('noCost')} /> : (
              <div className="space-y-3">
                {cost.byService.slice(0, 10).map((service) => (
                  <div key={service.service}>
                    <div className="mb-1 flex justify-between text-[13px]"><span className="text-fg-muted">{service.service}</span><span className="num">{fmtUsd(service.amount)}</span></div>
                    <Bar value={service.amount} max={costMax} tone="accent" />
                  </div>
                ))}
                {cost.byService.length > 10 && (
                  <div>
                    <div className="mb-1 flex justify-between text-[13px]"><span className="text-fg-muted">{t('costOther', { count: cost.byService.length - 10 })}</span><span className="num">{fmtUsd(cost.byService.slice(10).reduce((a, b) => a + b.amount, 0))}</span></div>
                    <Bar value={cost.byService.slice(10).reduce((a, b) => a + b.amount, 0)} max={costMax} tone="accent" />
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {data.controller && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-elev px-4 py-3 text-[13px]">
            <span className="font-medium">{t('controller')}</span>
            <Badge tone={data.controller.running ? 'ok' : 'err'}>{data.controller.running ? t('controllerUp') : t('controllerDown')}</Badge>
            {data.controller.lastTick && <span className="text-fg-muted">{t('controllerLastTick', { ago: ago(data.controller.lastTick) })}</span>}
            {data.controller.leased && <Badge tone="accent">{t('controllerLeased')}</Badge>}
            {data.controller.lastError && <ErrorBox error={{ message: data.controller.lastError }} className="w-full" />}
          </div>
        )}
      </div>
    </>
  );
}
