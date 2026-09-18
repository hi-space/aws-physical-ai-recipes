'use client';
import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Button, Card, EmptyState, ErrorBox, Select, Spinner, StatusPill, Table, Tabs } from '@/components/ui';
import { TimeSeries } from '@/components/charts/TimeSeries';
import { classNames as cx, shortId } from '@/lib/format';
import { apiQueryOptions, useApi } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';
import { compareParams, latestMetrics, metricSeries, type MetricHistory } from './experiment-compare';

interface MlExperiment {
  experiment_id: string;
  name: string;
  lifecycle_stage: string;
  last_update_time?: number;
  creation_time?: number;
}

interface MlRunInfo {
  run_id: string;
  run_name?: string;
  status: string;
  start_time: number;
  end_time?: number;
  user_id?: string;
  artifact_uri?: string;
}

interface MlMetric {
  key: string;
  value: number;
  step: number;
  timestamp: number;
}

interface MlRun {
  info: MlRunInfo;
  data: {
    metrics?: MlMetric[];
    params?: { key: string; value: string }[];
    tags?: { key: string; value: string }[];
  };
}

interface MlArtifact {
  path: string;
  is_dir: boolean;
  file_size?: number;
}

interface RunDetail {
  run: MlRun;
  artifacts: MlArtifact[];
}

export function ExperimentsPage() {
  const t = useT('experiments');
  const tr = useT('resources');
  const tc = useT('common');
  const { ago, fmtNum, fmtBytes } = useFormat();
  const me = useApi<any>('/api/me');
  const { data: experiments, isLoading: expLoading, error: expError } = useApi<MlExperiment[]>('/api/mlflow/experiments');
  const [selectedExp, setSelectedExp] = React.useState<string | null>(null);
  const [comparisonRuns, setComparisonRuns] = React.useState<MlRun[]>([]);
  const selectedRunIds = new Set(comparisonRuns.map((run) => run.info.run_id));
  const [selectedRun, setSelectedRun] = React.useState<string | null>(null);
  const [metricKey, setMetricKey] = React.useState<string>('');
  const [tab, setTab] = React.useState<'metrics' | 'params' | 'tags' | 'artifacts'>('metrics');

  // Auto-select first experiment
  React.useEffect(() => {
    if (experiments && experiments.length > 0 && !selectedExp) {
      setSelectedExp(experiments[0].experiment_id);
      setSelectedRun(null);
    }
  }, [experiments, selectedExp]);

  const { data: runs, isLoading: runsLoading, error: runsError } = useApi<MlRun[]>(
    selectedExp ? `/api/mlflow/runs?experiment=${encodeURIComponent(selectedExp)}&max=100` : null,
    { refetch: 10000 }
  );

  const { data: runDetail, error: detailError, isLoading: detailLoading } = useApi<RunDetail>(selectedRun ? `/api/mlflow/runs/${encodeURIComponent(selectedRun)}` : null, { refetch: 10000 });

  const { data: metricHistory, error: metricError, isLoading: metricLoading } = useApi<MetricHistory>(
    selectedRun && metricKey && tab === 'metrics' ? `/api/mlflow/runs/${encodeURIComponent(selectedRun)}/metrics?key=${encodeURIComponent(metricKey)}` : null,
    { refetch: 10000 },
  );

  const { data: uiUrlData, error: uiUrlError } = useApi<{ url: string }>('/api/mlflow/ui-url', { refetch: 240000 });

  // Compute most common metrics
  const commonMetrics = React.useMemo(() => {
    if (!runs) return [];
    const counts: Record<string, number> = {};
    for (const run of runs) {
      if (run.data.metrics) {
        for (const m of run.data.metrics) {
          counts[m.key] = (counts[m.key] ?? 0) + 1;
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k]) => k);
  }, [runs]);

  const handleOpenMlflow = () => {
    if (uiUrlData?.url) {
      window.open(uiUrlData.url, '_blank');
    }
  };

  if (expError?.code === 'not_configured') {
    return (
      <>
        <PageHeader title={t('title')} />
        <EmptyState title={t('notConfigured')} />
      </>
    );
  }

  const res = me.data?.resources;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('mlflow'), value: res?.mlflow?.trackingServerName ?? res?.mlflow?.trackingServerArn },
        ]}
      />
      {uiUrlError && <ErrorBox error={uiUrlError} />}
      {comparisonRuns.length > 0 && (
        <RunComparison runs={comparisonRuns} onRemove={(id) => setComparisonRuns((previous) => previous.filter((run) => run.info.run_id !== id))} />
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Experiments list */}
        <Card title={t('experimentsList')} actions={<Button onClick={handleOpenMlflow} disabled={!uiUrlData?.url}>{t('experimentOpen')}</Button>} className="lg:col-span-1">
          {expError && <ErrorBox error={expError} />}
          {expLoading && !experiments ? (
            <Spinner label={t('loadingExperiments')} />
          ) : !experiments?.length && !expError ? (
            <EmptyState title={t('noExperiments')} />
          ) : (
            <div className="space-y-1">
              {experiments?.map((exp) => (
                <button
                  key={exp.experiment_id}
                  onClick={() => {
                    setSelectedExp(exp.experiment_id);
                    setSelectedRun(null);
                    setMetricKey('');
                  }}
                  className={cx(
                    'w-full rounded border px-3 py-2 text-left text-sm transition-colors',
                    selectedExp === exp.experiment_id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-elev-2 hover:bg-bg-elev-3'
                  )}
                >
                  <div className="font-medium">{exp.name}</div>
                  <div className="text-xs text-fg-muted">
                    {exp.last_update_time && <>{tc('updated')} {ago(exp.last_update_time)}</>}
                  </div>
                  <div className="mono text-xs text-fg-faint">{shortId(exp.experiment_id)}</div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Right: Runs and detail */}
        <div className="lg:col-span-2 space-y-4">
          {/* Runs table */}
          <Card title={`Runs${selectedExp ? ` • ${shortId(selectedExp)}` : ''}`}>
            {runsError && <ErrorBox error={runsError} />}
            {!selectedExp ? (
              <EmptyState title={t('runSelect')} />
            ) : runsLoading && !runs ? (
              <Spinner label={t('loadingRuns')} />
            ) : !runs?.length && !runsError ? (
              <EmptyState title={tc('empty')} />
            ) : (
              <Table
                head={[
                  t('colCompare'),
                  t('colRun'),
                  t('colStatus'),
                  tc('started'),
                  t('colDuration'),
                  tc('user'),
                  ...commonMetrics.map((k) => k),
                ]}
                dense
              >
                {runs?.map((run) => {
                  const summaryMetrics = latestMetrics(run.data.metrics);
                  const duration = run.info.end_time ? run.info.end_time - run.info.start_time : undefined;
                  const isSelected = selectedRunIds.has(run.info.run_id);
                  return (
                    <tr
                      key={run.info.run_id}
                      onClick={() => { setSelectedRun(run.info.run_id); setMetricKey(''); }}
                      className={cx('cursor-pointer', selectedRun === run.info.run_id ? 'bg-accent/10' : '')}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t('compareSelectAriaLabel', { run: run.info.run_name || run.info.run_id })}
                          checked={isSelected}
                          disabled={!isSelected && comparisonRuns.length >= 4}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setComparisonRuns((previous) => checked
                              ? previous.length < 4 && !previous.some((item) => item.info.run_id === run.info.run_id) ? [...previous, run] : previous
                              : previous.filter((r) => r.info.run_id !== run.info.run_id));
                          }}
                        />
                      </td>
                      <td className="mono text-xs">{run.info.run_name || shortId(run.info.run_id)}</td>
                      <td>
                        <StatusPill status={run.info.status} />
                      </td>
                      <td className="text-fg-muted text-xs">{ago(run.info.start_time)}</td>
                      <td className="num text-xs">
                        {duration ? Math.round(duration / 1000) : '—'}s
                      </td>
                      <td className="text-fg-muted text-xs">{run.info.user_id || '—'}</td>
                      {commonMetrics.map((k) => (
                        <td key={k} className="num text-xs">
                          {summaryMetrics[k] !== undefined ? fmtNum(summaryMetrics[k].value) : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>

          {/* Run detail */}
          {detailError && <ErrorBox error={detailError} />}
          {detailLoading && <Spinner label={tc('loading')} />}
          {selectedRun && runDetail && (
            <Card title={t('runDetail')} description={runDetail.run.info.run_name || shortId(selectedRun)}>
              <Tabs
                value={tab}
                onChange={(t) => setTab(t as any)}
                items={[
                  { id: 'metrics' as const, label: t('tabMetrics') },
                  { id: 'params' as const, label: t('tabParams') },
                  { id: 'tags' as const, label: t('tabTags') },
                  { id: 'artifacts' as const, label: t('tabArtifacts') },
                ]}
              />
              <div className="mt-4">
                {tab === 'metrics' && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      {(runDetail.run.data.metrics || []).map((m) => (
                        <button
                          key={m.key}
                          onClick={() => setMetricKey(metricKey === m.key ? '' : m.key)}
                          className={cx(
                            'rounded px-2 py-1 text-xs transition-colors',
                            metricKey === m.key
                              ? 'bg-accent text-white'
                              : 'bg-bg-elev-2 hover:bg-bg-elev-3'
                          )}
                        >
                          {m.key}
                        </button>
                      ))}
                    </div>
                    {metricError && <ErrorBox error={metricError} />}
                    {metricLoading ? <Spinner label={t('metricLoadingHistory')} /> : metricKey && metricHistory ? (
                      <TimeSeries xAxis="step" series={metricSeries([runDetail.run], { [selectedRun]: metricHistory }, metricKey)} />
                    ) : (
                      <div className="text-sm text-fg-muted">{t('metricTrend')}</div>
                    )}
                  </div>
                )}
                {tab === 'params' && (
                  <div className="space-y-2">
                    {!runDetail.run.data.params?.length ? (
                      <div className="text-sm text-fg-muted">{t('noParams')}</div>
                    ) : (
                      <div className="space-y-2">
                        {runDetail.run.data.params.map((p) => (
                          <div key={p.key} className="flex items-center gap-3">
                            <div className="w-32 font-mono text-sm text-fg-muted">{p.key}</div>
                            <div className="font-mono text-sm">{p.value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {tab === 'tags' && (
                  <div className="space-y-2">
                    {!runDetail.run.data.tags?.length ? (
                      <div className="text-sm text-fg-muted">{t('noTags')}</div>
                    ) : (
                      <div className="space-y-2">
                        {runDetail.run.data.tags.map((t) => (
                          <div key={t.key} className="flex items-center gap-3">
                            <div className="w-32 font-mono text-sm text-fg-muted">{t.key}</div>
                            <div className="font-mono text-sm">{t.value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {tab === 'artifacts' && (
                  <div className="space-y-1">
                    {!runDetail.artifacts?.length ? (
                      <div className="text-sm text-fg-muted">{t('noArtifacts')}</div>
                    ) : (
                      runDetail.artifacts.map((a) => (
                        <div key={a.path} className="flex items-center gap-2 border-b border-border py-2">
                          <span className="text-fg-muted">{a.is_dir ? '📁' : '📄'}</span>
                          <span className="mono text-sm flex-1">{a.path}</span>
                          {a.file_size && <span className="text-xs text-fg-muted">{fmtBytes(a.file_size)}</span>}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function RunComparison({ runs, onRemove }: { runs: MlRun[]; onRemove: (id: string) => void }) {
  const t = useT('experiments');
  const tc = useT('common');
  const [metricKey, setMetricKey] = React.useState('');
  const details = useQueries({
    queries: runs.map((run) => apiQueryOptions<RunDetail>(`/api/mlflow/runs/${encodeURIComponent(run.info.run_id)}`, { refetch: 10000 })),
  });
  const currentRuns = runs.map((run, i) => details[i].data?.run ?? run);
  const keys = [...new Set(currentRuns.flatMap((run) => (run.data.metrics ?? []).map((metric) => metric.key)))].sort();
  const key = keys.includes(metricKey) ? metricKey : keys[0] ?? '';
  const histories = useQueries({
    queries: key ? runs.map((run) => apiQueryOptions<MetricHistory>(
      `/api/mlflow/runs/${encodeURIComponent(run.info.run_id)}/metrics?key=${encodeURIComponent(key)}`,
      { refetch: 10000 },
    )) : [],
  });
  const historyByRun = Object.fromEntries(runs.map((run, i) => [run.info.run_id, histories[i]?.data]));
  const series = metricSeries(currentRuns, historyByRun, key);
  const params = compareParams(currentRuns);

  return (
    <Card title={`${t('comparisonTitle')} (${runs.length}/4)`} className="mb-4">
      <div className="flex flex-wrap gap-2 mb-3">
        {currentRuns.map((run) => (
          <Button key={run.info.run_id} size="sm" variant="ghost" onClick={() => onRemove(run.info.run_id)}>
            {run.info.run_name || 'Run'} · {shortId(run.info.run_id)} — {t('comparisonRemove')}
          </Button>
        ))}
      </div>
      {details.map((query, i) => query.error && <ErrorBox key={runs[i].info.run_id} error={{ message: `${runs[i].info.run_id}: ${query.error.message}` }} />)}
      {histories.map((query, i) => query.error && <ErrorBox key={runs[i].info.run_id} error={{ message: `${runs[i].info.run_id}: ${query.error.message}` }} />)}
      {keys.length > 0 ? (
        <>
          <label className="block text-xs mb-2">
            {t('comparisonMetrics')}
            <Select value={key} onChange={(event) => setMetricKey(event.target.value)} className="mt-1">
              {keys.map((metric) => <option key={metric} value={metric}>{metric}</option>)}
            </Select>
          </label>
          {histories.some((query) => query.isLoading) && <Spinner label={tc('loading')} />}
          <TimeSeries xAxis="step" series={series} />
          {series.map((s, i) => !histories[i].isLoading && !histories[i].error && !s.values.length && (
            <p key={runs[i].info.run_id} className="text-xs text-fg-muted">{s.name}: {key} {t('colNoData')}</p>
          ))}
        </>
      ) : <EmptyState title={tc('empty')} />}
      <h3 className="text-sm font-medium mt-4 mb-2">{t('comparisonParams')}</h3>
      {params.length ? (
        <Table head={[t('colParamKey'), ...currentRuns.map((run) => `${run.info.run_name || 'Run'} · ${shortId(run.info.run_id)}`)]} dense>
          {params.map((row) => (
            <tr key={row.key} className={row.differs ? 'bg-accent/10' : ''}>
              <td className="font-mono">{row.key}{row.differs && <span className="ml-2 text-xs text-fg-muted">{t('colDiffers')}</span>}</td>
              {row.values.map((value, i) => <td key={runs[i].info.run_id} className="font-mono">{value ?? '—'}</td>)}
            </tr>
          ))}
        </Table>
      ) : <EmptyState title={tc('empty')} />}
    </Card>
  );
}
