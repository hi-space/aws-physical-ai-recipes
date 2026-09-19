'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, ChevronDown, Download, Trash2, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CodeBlock, Dialog, EmptyState, ErrorBox, Input, Select, Skeleton, Spinner, Stat, StatusPill, TechnicalDetails } from '@/components/ui';
import { fmtNum, fmtDuration, shortId } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';

interface Job {
  name: string;
  namespace: string;
  created: string;
  startTime?: string;
  completionTime?: string;
  active: number;
  succeeded: number;
  failed: number;
  completions: number;
  suspended: boolean;
  state: string;
  queue?: string;
  priority?: string;
  workflowId?: string;
  task?: string;
  app?: string;
  image?: string;
  nodeSelector?: Record<string, string>;
  gpu?: string | number;
  pods: Array<{ name: string; phase?: string; node?: string; started?: string; restarts: number }>;
}

interface Event {
  ts: string;
  type: string;
  reason: string;
  message: string;
  count: number;
  object: string;
  namespace: string;
  source?: string;
}

const STATE_COLORS: Record<string, 'ok' | 'warn' | 'err' | 'info'> = {
  Running: 'info',
  Succeeded: 'ok',
  Failed: 'err',
  Pending: 'warn',
  Unknown: 'warn',
};

import { ResourceStrip } from '@/components/layout/ResourceStrip';

export function JobsPage() {
  const t = useT('jobs');
  const tc = useT('common');
  const tr = useT('resources');
  const { ago, fmtTime } = useFormat();
  const { data: me } = useMe();
  const [namespace, setNamespace] = React.useState('');
  const [stateFilter, setStateFilter] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [selectedJob, setSelectedJob] = React.useState<Job | null>(null);
  const [selectedPodIdx, setSelectedPodIdx] = React.useState(0);
  const [logsFollow, setLogsFollow] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState<Job | null>(null);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const { data: jobs, isLoading: jobsLoading, error: jobsError } = useApi<Job[]>(`/api/k8s/jobs?ns=${namespace}`, { refetch: 5000 });
  const { data: namespaces, isLoading: nsLoading } = useApi<string[]>('/api/k8s/namespaces');
  const { data: events, isLoading: eventsLoading } = useApi<Event[]>(`/api/k8s/events?ns=${namespace}&limit=100`, { refetch: 5000 });

  const { mutate: deleteMutation } = useApiMutation(
    (job: Job) => fetch(`/api/k8s/jobs/${job.namespace}/${job.name}`, { method: 'DELETE' }).then((r) => (r.ok ? { ok: true } : r.json().then((e) => Promise.reject(e)))),
    [`/api/k8s/jobs?ns=${namespace}`],
  );

  const filteredJobs = React.useMemo(() => {
    let result = jobs ?? [];
    if (stateFilter) result = result.filter((j) => j.state === stateFilter);
    if (search) result = result.filter((j) => j.name.includes(search) || j.namespace.includes(search) || j.image?.includes(search));
    return result;
  }, [jobs, stateFilter, search]);

  const stats = React.useMemo(() => {
    if (!jobs) return { running: 0, pending: 0, succeeded: 0, failed: 0 };
    return {
      running: jobs.filter((j) => j.state === 'Running').length,
      pending: jobs.reduce((sum, j) => sum + (j.pods?.filter((p) => p.phase === 'Pending').length ?? 0), 0),
      succeeded: jobs.reduce((sum, j) => sum + j.succeeded, 0),
      failed: jobs.reduce((sum, j) => sum + j.failed, 0),
    };
  }, [jobs]);

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteMutation(deleteConfirm);
      setToast({ message: t('deleted', { name: deleteConfirm.name }), tone: 'ok' });
      setDeleteConfirm(null);
    } catch (e) {
      setToast({ message: t('deleteError', { message: (e as Error).message }), tone: 'err' });
    }
  };

  if (jobsLoading && !jobs) return <Spinner label={t('loadingJobs')} />;

  const res = me?.resources;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('eksCluster'), value: res?.hyperPodEks?.eksClusterName, console: res?.hyperPodEks ? { kind: 'eks-cluster', name: res.hyperPodEks.eksClusterName } : undefined },
          { label: tr('namespace'), value: me?.defaultNamespace },
        ]}
      />

      {/* Toast */}
      {toast && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-bg-elev-2 p-3 text-sm">
          <div className={`flex-1 ${toast.tone === 'err' ? 'text-err' : 'text-ok'}`}>{toast.message}</div>
          <button onClick={() => setToast(null)} className="text-fg-muted">
            ×
          </button>
        </div>
      )}

      {/* KPI Row */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('running')} value={fmtNum(stats.running)} tone={stats.running > 0 ? 'info' : undefined} />
        <Stat label={t('pending')} value={fmtNum(stats.pending)} tone={stats.pending > 0 ? 'warn' : undefined} />
        <Stat label={t('succeeded')} value={fmtNum(stats.succeeded)} tone="ok" />
        <Stat label={t('failed')} value={fmtNum(stats.failed)} tone={stats.failed > 0 ? 'err' : undefined} />
      </div>

      {jobsError && <ErrorBox error={jobsError} />}

      {/* Filter Bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={namespace} onChange={(e) => setNamespace(e.target.value)} className="w-40">
          <option value="">{t('allNamespaces')}</option>
          {namespaces?.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </Select>
        <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-32">
          <option value="">{t('allStates')}</option>
          <option value="Running">{t('running')}</option>
          <option value="Succeeded">{tc('stSucceeded')}</option>
          <option value="Failed">{tc('stFailed')}</option>
          <option value="Pending">{tc('stPending')}</option>
        </Select>
        <Input placeholder={t('searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 min-w-40" />
      </div>

      {/* Jobs Table */}
      <Card title={`${t('title')} (${filteredJobs.length})`} className="mb-4">
        {!filteredJobs.length ? (
          <EmptyState title={t('noJobsFound')} hint={jobs?.length ? t('jobDetailsHint') : t('noJobs')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">{tc('name')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('namespace')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('state')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('pods')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('queue')} / {tc('priority')}</th>
                  <th className="px-3 py-2 text-center font-medium">GPU</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('image')}</th>
                  <th className="px-3 py-2 text-right font-medium">{tc('age')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('duration')}</th>
                  <th className="px-3 py-2 text-right font-medium">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredJobs.map((job) => {
                  const podsSummary = (job.pods ?? [])
                    .reduce((acc, p) => {
                      acc[p.phase ?? 'Unknown'] = (acc[p.phase ?? 'Unknown'] ?? 0) + 1;
                      return acc;
                    }, {} as Record<string, number>);
                  const duration =
                    job.startTime && job.completionTime
                      ? fmtDuration(new Date(job.completionTime).getTime() - new Date(job.startTime).getTime())
                      : job.startTime
                        ? fmtDuration(Date.now() - new Date(job.startTime).getTime())
                        : '—';

                  return (
                    <tr key={`${job.namespace}/${job.name}`} className="hover:bg-bg-elev-2">
                      <td className="mono px-3 py-2 text-fg-muted">{shortId(job.name, 20)}</td>
                      <td className="px-3 py-2">{job.namespace}</td>
                      <td className="px-3 py-2">
                        <StatusPill status={job.state} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex justify-center gap-1">
                          {Object.entries(podsSummary).map(([phase, count]) => (
                            <Badge key={phase} tone={phase === 'Running' ? 'info' : phase === 'Succeeded' ? 'ok' : 'warn'}>
                              {count} {phase}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {job.queue && <Badge tone="info">{job.queue}</Badge>}
                          {job.priority && <Badge>{job.priority}</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">{job.gpu ? <Badge tone="accent">{job.gpu}x GPU</Badge> : '—'}</td>
                      <td className="mono px-3 py-2 truncate text-fg-muted" title={job.image}>
                        {job.image?.split('/').pop()?.split(':')[0]}
                      </td>
                      <td className="px-3 py-2 text-right text-fg-muted">{ago(job.created)}</td>
                      <td className="px-3 py-2">{duration}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => {
                              setSelectedJob(job);
                              setSelectedPodIdx(0);
                              setLogsFollow(false);
                            }}
                            className="rounded px-2 py-1 hover:bg-bg-elev-2"
                            title={t('logs')}
                          >
                            <Zap size={14} className="text-fg-muted" />
                          </button>
                          {can(me, 'researcher') && (
                            <button
                              onClick={() => setDeleteConfirm(job)}
                              className="rounded px-2 py-1 hover:bg-red-500/10"
                              title={t('delete')}
                            >
                              <Trash2 size={14} className="text-err" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Logs Drawer */}
      {selectedJob && (
        <Dialog
          open={!!selectedJob}
          onClose={() => setSelectedJob(null)}
          title={`${t('logs')}: ${selectedJob.name}`}
          width="xl"
        >
          <div className="space-y-3">
            <TechnicalDetails
              rows={[
                { label: tc('name'), value: selectedJob.name, copy: true, mono: true },
                { label: tc('namespace'), value: selectedJob.namespace, copy: true, mono: true },
                { label: t('workflowId'), value: selectedJob.workflowId, copy: true, mono: true },
                { label: tc('task'), value: selectedJob.task, copy: true, mono: true },
                { label: t('podNames'), value: (selectedJob.pods ?? []).map((p) => p.name).join(', '), copy: true, mono: true },
              ]}
              defaultOpen={false}
            />
            <LogViewer job={selectedJob} podIdx={selectedPodIdx} setPodIdx={setSelectedPodIdx} follow={logsFollow} setFollow={setLogsFollow} />
          </div>
        </Dialog>
      )}

      {/* Delete Confirm Dialog */}
      {deleteConfirm && (
        <Dialog
          open={!!deleteConfirm}
          onClose={() => setDeleteConfirm(null)}
          title={t('deleteConfirm', { name: deleteConfirm.name })}
        >
          <div className="space-y-4">
            <p className="text-sm">
              {t('deleteConfirm', { name: deleteConfirm.name })}
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setDeleteConfirm(null)} variant="secondary">
                {tc('cancel')}
              </Button>
              <Button onClick={handleDelete} variant="danger">
                {tc('delete')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Cluster Events */}
      <Card title={t('clusterEvents')} description={t('clusterEventsDesc', { ns: namespace || t('allNamespaces') })}>
        {eventsLoading ? (
          <Spinner />
        ) : !events?.length ? (
          <EmptyState title={t('noEvents')} />
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 border-l-2 border-border bg-bg-elev-2 px-3 py-2 text-xs">
                <div className={`mt-0.5 text-lg ${e.type === 'Warning' ? 'text-warn' : e.type === 'Error' ? 'text-err' : 'text-ok'}`}>
                  {e.type === 'Warning' ? '⚠' : e.type === 'Error' ? '✕' : '✓'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{e.reason}</span>
                    <span className="text-fg-muted">× {e.count}</span>
                  </div>
                  <div className="text-fg-muted mt-1">{e.message}</div>
                  <div className="text-fg-faint mt-1">
                    {e.object} in {e.namespace} • {ago(e.ts)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function LogViewer({
  job,
  podIdx,
  setPodIdx,
  follow,
  setFollow,
}: {
  job: Job;
  podIdx: number;
  setPodIdx: (idx: number) => void;
  follow: boolean;
  setFollow: (v: boolean) => void;
}) {
  const t = useT('jobs');
  const tc = useT('common');
  const pods = job.pods ?? [];
  const pod = pods[podIdx];
  const [searchTerm, setSearchTerm] = React.useState('');
  const logsUrl = pod ? `/api/k8s/pods/${job.namespace}/${pod.name}/logs?tail=1000` : '';

  const { data: logsData, isLoading, error: logsError } = useApi<{ source: string; phase?: string; lines: { ts: string; text: string }[] }>(logsUrl, { refetch: follow ? 2000 : 0 });

  const filteredLines = React.useMemo(() => {
    if (!logsData?.lines) return [];
    if (!searchTerm) return logsData.lines;
    return logsData.lines.filter((line) => line.text.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [logsData?.lines, searchTerm]);

  if (!pod) return <EmptyState title={t('noJobs')} />;

  return (
    <div className="space-y-3">
      {/* Pod Selector */}
      <div className="flex gap-2 items-center">
        <span className="text-xs font-medium">{t('pods')}:</span>
        <select value={podIdx} onChange={(e) => setPodIdx(Number(e.target.value))} className="rounded border border-border bg-bg-elev px-2 py-1 text-xs" title={pod?.name}>
          {pods.map((p, i) => (
            <option key={i} value={i} title={p.name}>
              {tc('replica', { number: String(i + 1) })} ({p.phase})
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={logsError} />

      {/* Log Viewer Controls */}
      <div className="flex gap-2 items-center">
        <Input
          placeholder={t('searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1 text-xs"
        />
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {t('followLogs')}
        </label>
        <button
          onClick={() => {
            const text = filteredLines.map((line) => line.text).join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${job.name}-${pod.name}.log`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="rounded p-1 hover:bg-bg-elev-2"
          title={tc('download')}
        >
          <Download size={14} />
        </button>
      </div>

      {/* Logs Display */}
      <div className="bg-black rounded border border-border p-3 font-mono text-xs text-green-400 overflow-auto max-h-96">
        {isLoading ? (
          <Spinner />
        ) : !filteredLines.length ? (
          <div className="text-fg-muted">{tc('notAvailable')}</div>
        ) : (
          <div>
            {filteredLines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {line.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-fg-muted">
        {tc('status')}: {logsData?.source} {logsData?.phase ? `• ${t('phase')}: ${logsData.phase}` : ''}
      </div>
    </div>
  );
}
