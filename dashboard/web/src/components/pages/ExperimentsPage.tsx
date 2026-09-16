'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Skeleton, Spinner, StatusPill, Table, Tabs, Toast } from '@/components/ui';
import { TimeSeries, toSeries } from '@/components/charts/TimeSeries';
import { ago, classNames as cx, fmtBytes, fmtNum, shortId } from '@/lib/format';
import { useApi } from '@/lib/api-client';

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

interface MetricHistory {
  [key: string]: { value: number; step: number; timestamp: number }[];
}

export function ExperimentsPage() {
  const { data: experiments, isLoading: expLoading, error: expError } = useApi<MlExperiment[]>('/api/mlflow/experiments');
  const [selectedExp, setSelectedExp] = React.useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = React.useState<Set<string>>(new Set());
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

  const { data: runs, isLoading: runsLoading } = useApi<MlRun[]>(
    selectedExp ? `/api/mlflow/runs?experiment=${selectedExp}&max=100` : null,
    { refetch: 10000 }
  );

  const { data: runDetail } = useApi<RunDetail>(selectedRun ? `/api/mlflow/runs/${selectedRun}` : null);

  const { data: metricHistory } = useApi<MetricHistory>(
    selectedRun && metricKey ? `/api/mlflow/runs/${selectedRun}/metrics?key=${metricKey}` : null
  );

  const { data: uiUrlData } = useApi<{ url: string }>('/api/mlflow/ui-url');

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

  if (expError && expError.message.includes('not_configured')) {
    return (
      <>
        <PageHeader title="Experiments" />
        <EmptyState title="MLflow not configured" hint="No tracking server deployed in this account" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Experiments" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Experiments list */}
        <Card title="Experiments" actions={<Button onClick={handleOpenMlflow}>Open MLflow UI</Button>} className="lg:col-span-1">
          {expError && <ErrorBox error={expError} />}
          {expLoading && !experiments ? (
            <Spinner label="Loading experiments…" />
          ) : !experiments?.length ? (
            <EmptyState title="No experiments" />
          ) : (
            <div className="space-y-1">
              {experiments.map((exp) => (
                <button
                  key={exp.experiment_id}
                  onClick={() => {
                    setSelectedExp(exp.experiment_id);
                    setSelectedRun(null);
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
                    {exp.last_update_time && <>Updated {ago(exp.last_update_time)}</>}
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
            {!selectedExp ? (
              <EmptyState title="Select an experiment" />
            ) : runsLoading && !runs ? (
              <Spinner label="Loading runs…" />
            ) : !runs?.length ? (
              <EmptyState title="No runs in this experiment" />
            ) : (
              <Table
                head={[
                  '',
                  'Run',
                  'Status',
                  'Started',
                  'Duration',
                  'Owner',
                  ...commonMetrics.map((k) => k),
                ]}
                dense
              >
                {runs.map((run) => {
                  const latestMetrics: Record<string, number> = {};
                  if (run.data.metrics) {
                    for (const m of run.data.metrics) {
                      if (!latestMetrics[m.key] || m.step > (latestMetrics[m.key] as any)) {
                        latestMetrics[m.key] = m.value;
                      }
                    }
                  }
                  const duration = run.info.end_time ? run.info.end_time - run.info.start_time : undefined;
                  const isSelected = selectedRunIds.has(run.info.run_id);
                  return (
                    <tr
                      key={run.info.run_id}
                      onClick={() => setSelectedRun(run.info.run_id)}
                      className={cx('cursor-pointer', selectedRun === run.info.run_id ? 'bg-accent/10' : '')}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            e.stopPropagation();
                            const newSet = new Set(selectedRunIds);
                            if (e.target.checked && newSet.size < 4) {
                              newSet.add(run.info.run_id);
                            } else if (!e.target.checked) {
                              newSet.delete(run.info.run_id);
                            }
                            setSelectedRunIds(newSet);
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
                          {latestMetrics[k] !== undefined ? fmtNum(latestMetrics[k]) : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>

          {/* Run detail */}
          {selectedRun && runDetail && (
            <Card title="Run Detail" description={runDetail.run.info.run_name || shortId(selectedRun)}>
              <Tabs
                value={tab}
                onChange={(t) => setTab(t as any)}
                items={[
                  { id: 'metrics' as const, label: 'Metrics' },
                  { id: 'params' as const, label: 'Params' },
                  { id: 'tags' as const, label: 'Tags' },
                  { id: 'artifacts' as const, label: 'Artifacts' },
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
                    {metricKey && metricHistory ? (
                      <StepChart
                        series={[
                          {
                            name: metricKey,
                            points: metricHistory[metricKey] || [],
                          },
                        ]}
                      />
                    ) : (
                      <div className="text-sm text-fg-muted">Select a metric to view chart</div>
                    )}
                  </div>
                )}
                {tab === 'params' && (
                  <div className="space-y-2">
                    {!runDetail.run.data.params?.length ? (
                      <div className="text-sm text-fg-muted">No parameters</div>
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
                      <div className="text-sm text-fg-muted">No tags</div>
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
                      <div className="text-sm text-fg-muted">No artifacts</div>
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

function StepChart({
  series,
}: {
  series: {
    name: string;
    points: { step: number; value: number; timestamp: number }[];
  }[];
}) {
  // Simple text-based chart for now; in a real app use recharts LineChart
  if (!series[0]?.points.length) {
    return <div className="text-sm text-fg-muted">No data points</div>;
  }
  return (
    <TimeSeries
      series={series.map((s) => ({
        name: s.name,
        values: s.points.map((p) => [p.step, p.value]),
      }))}
    />
  );
}
