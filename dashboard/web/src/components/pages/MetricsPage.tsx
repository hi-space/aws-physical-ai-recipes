'use client';
import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Button, Card, CodeBlock, EmptyState, ErrorBox, Spinner, Tabs } from '@/components/ui';
import { TimeSeries, toSeries } from '@/components/charts/TimeSeries';
import { fmtBytes } from '@/lib/format';
import { useApi, useMe } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import Link from 'next/link';

interface MetricsResult {
  promql: string;
  series?: Array<{ metric: Record<string, string>; values: [number, number][] }>;
  instant?: Array<{ metric: Record<string, string>; value: [number, number] }>;
  error?: string;
}

export function MetricsPage() {
  const t = useT('metrics');
  const tr = useT('resources');
  const tc = useT('common');
  const me = useMe();
  const admin = me.data?.role === 'admin';
  const [timeRange, setTimeRange] = React.useState<'15m' | '1h' | '3h' | '6h' | '24h' | '7d'>('1h');
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [nodeFilter, setNodeFilter] = React.useState('');
  const [tab, setTab] = React.useState<'dashboards' | 'grafana'>('dashboards');
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));

  React.useEffect(() => {
    if (!autoRefresh || tab !== 'dashboards') return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, [autoRefresh, tab]);

  const rangeMs = React.useMemo(() => {
    const ranges = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '3h': 3 * 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };
    return ranges[timeRange];
  }, [timeRange]);

  const start = now - Math.floor(rangeMs / 1000);
  const step = Math.max(15, Math.min(3600, Math.floor((now - start) / 200)));

  const queries = React.useMemo(
    () => [
      { id: 'gpu_util', metric: 'gpu_util', params: nodeFilter ? { node: nodeFilter } : {} },
      { id: 'gpu_mem', metric: 'gpu_mem_used', params: nodeFilter ? { node: nodeFilter } : {} },
      { id: 'gpu_power', metric: 'gpu_power', params: nodeFilter ? { node: nodeFilter } : {} },
      { id: 'gpu_temp', metric: 'gpu_temp', params: nodeFilter ? { node: nodeFilter } : {} },
      { id: 'gpu_clock', metric: 'gpu_sm_clock', params: nodeFilter ? { node: nodeFilter } : {} },
      { id: 'node_cpu', metric: 'node_cpu', params: {} },
      { id: 'node_mem', metric: 'node_mem', params: {} },
      { id: 'node_net', metric: 'node_net_rx', params: {} },
      { id: 'kueue_pend', metric: 'kueue_pending', params: {} },
      { id: 'kueue_adm', metric: 'kueue_admitted', params: {} },
      { id: 'kueue_gpu', metric: 'kueue_usage_gpu', params: {} },
      { id: 'kueue_cpu', metric: 'kueue_usage_cpu', params: {} },
      { id: 'gpu_alloc', metric: 'gpu_allocatable', params: {} },
      { id: 'gpu_req', metric: 'gpu_requested', params: {} },
    ].filter((query) => admin || !['gpu_power', 'gpu_temp', 'gpu_sm_clock', 'node_net_rx', 'gpu_allocatable'].includes(query.metric))
      .map((query) => admin ? query : { ...query, metric: query.metric === 'node_cpu' ? 'pod_cpu' : query.metric === 'node_mem' ? 'pod_mem' : query.metric }),
    [nodeFilter, admin],
  );

  const range = { start, end: now, step };
  // The endpoint accepts at most 12 queries per request.
  const main = useApi<Record<string, MetricsResult>>('/api/metrics/query', {
    enabled: Boolean(me.data) && tab === 'dashboards',
    init: { method: 'POST', json: { queries: queries.slice(0, 12), range } },
  });
  const capacity = useApi<Record<string, MetricsResult>>('/api/metrics/query', {
    enabled: Boolean(me.data) && tab === 'dashboards' && queries.length > 12,
    init: { method: 'POST', json: { queries: queries.slice(12), range } },
  });
  const metricsData = React.useMemo(() => main.data || capacity.data ? { ...main.data, ...capacity.data } : undefined, [main.data, capacity.data]);
  const isLoading = main.isLoading || capacity.isLoading;
  const queryErrors = Object.entries(metricsData ?? {}).filter(([, result]) => result.error);
  const gpuError = main.error || queryErrors.some(([id]) => id.startsWith('gpu_'));

  const gpuMetrics = React.useMemo(() => {
    const data = metricsData;
    if (!data) return { util: [], mem: [], power: [], temp: [], clock: [], allEmpty: true };
    const util = toSeries(data.gpu_util?.series, ['Hostname', 'gpu']);
    const mem = toSeries(data.gpu_mem?.series, ['Hostname', 'gpu']);
    const power = toSeries(data.gpu_power?.series, ['Hostname', 'gpu']);
    const temp = toSeries(data.gpu_temp?.series, ['Hostname', 'gpu']);
    const clock = toSeries(data.gpu_clock?.series, ['Hostname', 'gpu']);
    return { util, mem, power, temp, clock, allEmpty: !util.length && !mem.length && !power.length && !temp.length && !clock.length };
  }, [metricsData]);

  const nodeMetrics = React.useMemo(() => {
    const data = metricsData;
    if (!data) return { cpu: [], mem: [], net: [] };
    const cpu = toSeries(data.node_cpu?.series, ['instance', 'pod']);
    const mem = toSeries(data.node_mem?.series, ['instance', 'pod']);
    const net = toSeries(data.node_net?.series, ['instance']);
    return { cpu, mem, net };
  }, [metricsData]);

  const kueueMetrics = React.useMemo(() => {
    const data = metricsData;
    if (!data) return { pending: [], admitted: [], gpu: [], cpu: [] };
    const pending = toSeries(data.kueue_pend?.series, ['cluster_queue']);
    const admitted = toSeries(data.kueue_adm?.series, ['cluster_queue']);
    const gpu = toSeries(data.kueue_gpu?.series, ['cluster_queue']);
    const cpu = toSeries(data.kueue_cpu?.series, ['cluster_queue']);
    return { pending, admitted, gpu, cpu };
  }, [metricsData]);

  const capacityMetrics = React.useMemo(() => {
    const data = metricsData;
    if (!data) return { allocatable: [], requested: [] };
    const allocatable = toSeries(data.gpu_alloc?.series, []);
    const requested = toSeries(data.gpu_req?.series, []);
    return { allocatable, requested };
  }, [metricsData]);

  const res = me.data?.resources;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('amp'), value: res?.amp?.workspaceId, console: res?.amp ? { kind: 'amp-workspace', id: res.amp.workspaceId } : undefined },
          { label: tr('clusterLogGroup'), value: res?.hyperPodEks?.logGroupPrefix, console: res?.hyperPodEks?.logGroupPrefix ? { kind: 'log-group', name: res.hyperPodEks.logGroupPrefix } : undefined },
        ]}
      />

      <Tabs
        items={[
          { id: 'dashboards', label: t('dashboards') },
          ...(admin ? [{ id: 'grafana', label: t('grafana') }] : []),
        ]}
        value={tab}
        onChange={(v) => { setTab(v as 'dashboards' | 'grafana'); setNow(Math.floor(Date.now() / 1000)); }}
        className="mb-4"
      />

      {tab === 'dashboards' && (
        <>
          {/* Controls */}
          <div className="mb-4 flex flex-wrap gap-3 items-center">
            <div className="flex gap-1">
              {(['15m', '1h', '3h', '6h', '24h', '7d'] as const).map((tr) => (
                <button
                  key={tr}
                  onClick={() => { setTimeRange(tr); setNow(Math.floor(Date.now() / 1000)); }}
                  aria-pressed={timeRange === tr}
                  className={`rounded px-2 py-1 text-xs font-medium ${timeRange === tr ? 'bg-accent text-white' : 'bg-bg-elev-2 hover:bg-bg-elev-3'}`}
                >
                  {tr}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              {t('autoRefreshLabel')}
            </label>
            {admin && <input
              type="text"
              aria-label={t('nodeFilterLabel')}
              placeholder={t('nodeFilterLabel')}
              value={nodeFilter}
              onChange={(e) => { setNodeFilter(e.target.value); setNow(Math.floor(Date.now() / 1000)); }}
              className="rounded border border-border bg-bg-elev px-2 py-1 text-xs flex-1 max-w-48"
            />}
            <Button onClick={() => {
              const next = Math.floor(Date.now() / 1000);
              if (next !== now) setNow(next);
              else { void main.refetch(); if (queries.length > 12) void capacity.refetch(); }
            }} disabled={main.isFetching || capacity.isFetching}>{t('refresh')}</Button>
          </div>

          {main.error && <ErrorBox error={main.error} />}
          {capacity.error && <ErrorBox error={capacity.error} />}
          {queryErrors.map(([id, result]) => <ErrorBox key={id} error={{ message: `${id}: ${result.error}` }} />)}
          {isLoading && !metricsData ? (
            <Spinner label={t('loading')} />
          ) : (
            <div className="space-y-4">
              {/* GPU Metrics */}
              <Card title={t('gpuMetrics')}>
                {gpuMetrics.allEmpty ? (
                  <EmptyState title={gpuError ? t('gpuLoadFailed') : t('noGpuMetrics')} />
                ) : (
                  <div className="space-y-4">
                    {gpuMetrics.util.length > 0 && (
                      <MetricSection title={t('utilization')} promql={metricsData?.gpu_util?.promql}>
                        <TimeSeries series={gpuMetrics.util} unit="%" formatter={(v) => `${Math.round(v)}%`} height={220} yMax={100} />
                      </MetricSection>
                    )}
                    {gpuMetrics.mem.length > 0 && (
                      <MetricSection title={t('memory')} promql={metricsData?.gpu_mem?.promql}>
                        <TimeSeries series={gpuMetrics.mem} unit=" GiB" formatter={(v) => `${(v / 1024).toFixed(1)} GiB`} height={220} />
                      </MetricSection>
                    )}
                    {gpuMetrics.power.length > 0 && (
                      <MetricSection title={t('power')} promql={metricsData?.gpu_power?.promql}>
                        <TimeSeries series={gpuMetrics.power} unit=" W" height={220} />
                      </MetricSection>
                    )}
                    {gpuMetrics.temp.length > 0 && (
                      <MetricSection title={t('temperature')} promql={metricsData?.gpu_temp?.promql}>
                        <TimeSeries series={gpuMetrics.temp} unit="°C" height={220} />
                      </MetricSection>
                    )}
                    {gpuMetrics.clock.length > 0 && (
                      <MetricSection title={t('clock')} promql={metricsData?.gpu_clock?.promql}>
                        <TimeSeries series={gpuMetrics.clock} unit=" MHz" height={220} />
                      </MetricSection>
                    )}
                  </div>
                )}
              </Card>

              {/* Node Metrics */}
              <Card title={admin ? t('nodeMetrics') : t('projectWork')}>
                <div className="space-y-4">
                  {nodeMetrics.cpu.length > 0 && (
                    <MetricSection title={admin ? t('cpu') : 'CPU (cores)'} promql={metricsData?.node_cpu?.promql}>
                      <TimeSeries series={nodeMetrics.cpu} unit={admin ? '%' : ' cores'} height={220} yMax={admin ? 100 : undefined} />
                    </MetricSection>
                  )}
                  {nodeMetrics.mem.length > 0 && (
                    <MetricSection title={admin ? 'Memory (%)' : t('memory')} promql={metricsData?.node_mem?.promql}>
                      <TimeSeries series={nodeMetrics.mem} unit={admin ? '%' : ' bytes'} formatter={admin ? (v) => `${Math.round(v)}%` : fmtBytes} height={220} yMax={admin ? 100 : undefined} />
                    </MetricSection>
                  )}
                  {nodeMetrics.net.length > 0 && (
                    <MetricSection title={t('network')} promql={metricsData?.node_net?.promql}>
                      <TimeSeries series={nodeMetrics.net} unit="/s" formatter={(v) => `${fmtBytes(v)}/s`} height={220} />
                    </MetricSection>
                  )}
                </div>
              </Card>

              {/* Kueue Metrics */}
              <Card title={t('kueueMetrics')}>
                <div className="space-y-4">
                  {(kueueMetrics.pending.length > 0 || kueueMetrics.admitted.length > 0) && (
                    <MetricSection
                      title={t('workloads')}
                      promql={metricsData?.kueue_pend?.promql}
                    >
                      <TimeSeries
                        series={[...kueueMetrics.pending.map((s) => ({ ...s, name: `${s.name} (pending)` })), ...kueueMetrics.admitted.map((s) => ({ ...s, name: `${s.name} (admitted)` }))]}
                        unit=""
                        height={220}
                      />
                    </MetricSection>
                  )}
                  {(kueueMetrics.gpu.length > 0 || kueueMetrics.cpu.length > 0) && (
                    <MetricSection title={t('resourceUsage')} promql={metricsData?.kueue_gpu?.promql}>
                      <TimeSeries series={[...kueueMetrics.gpu, ...kueueMetrics.cpu]} unit="" height={220} />
                    </MetricSection>
                  )}
                </div>
              </Card>

              {/* Capacity */}
              <Card title={t('capacity')}>
                <div className="space-y-4">
                  {(capacityMetrics.allocatable.length > 0 || capacityMetrics.requested.length > 0) && (
                    <MetricSection title={t('gpuAllocVsReq')} promql={metricsData?.gpu_alloc?.promql}>
                      <TimeSeries series={[...capacityMetrics.allocatable.map((s) => ({ ...s, name: `${s.name} (allocatable)` })), ...capacityMetrics.requested.map((s) => ({ ...s, name: `${s.name} (requested)` }))]} unit="" height={220} />
                    </MetricSection>
                  )}
                </div>
              </Card>
            </div>
          )}
        </>
      )}

      {tab === 'grafana' && (
        <div className="space-y-4">
          <Card title={t('grafana')}>
            <div className="space-y-4 px-4 py-3">
              <p className="text-xs text-fg-muted">
                {t('grafanaDesc')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                <Link href="/absproxy/3000/d/hyperpod-task-governance" className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elev-2 hover:bg-[#1e2637] text-fg font-medium transition-colors text-[13px] px-3 h-8">
                  {t('taskGov')}
                  <ExternalLink size={12} />
                </Link>
                <Link href="/absproxy/3000/dashboards?query=DCGM" className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elev-2 hover:bg-[#1e2637] text-fg font-medium transition-colors text-[13px] px-3 h-8">
                  {t('dcgm')}
                  <ExternalLink size={12} />
                </Link>
                <Link href="/absproxy/3000/dashboards?query=Node+Exporter" className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elev-2 hover:bg-[#1e2637] text-fg font-medium transition-colors text-[13px] px-3 h-8">
                  {t('nodeExporter')}
                  <ExternalLink size={12} />
                </Link>
                <Link href="/absproxy/3000/dashboards?query=Kubernetes" className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elev-2 hover:bg-[#1e2637] text-fg font-medium transition-colors text-[13px] px-3 h-8">
                  {t('kubeViews')}
                  <ExternalLink size={12} />
                </Link>
              </div>
              <iframe
                src="/absproxy/3000/?kiosk=tv&theme=dark"
                className="h-[80vh] w-full rounded border border-border"
                title={t('grafana')}
              />
              <Link href="/absproxy/3000/" className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elev-2 hover:bg-[#1e2637] text-fg font-medium transition-colors h-8 px-3 text-[13px]">
                {t('openGrafana')}
                <ExternalLink size={14} />
              </Link>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function MetricSection({ title, promql, children }: { title: string; promql?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">{title}</h3>
      {children}
      {promql && (
        <details>
          <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">PromQL</summary>
          <div className="mt-2">
            <CodeBlock code={promql} lang="promql" />
          </div>
        </details>
      )}
    </div>
  );
}
