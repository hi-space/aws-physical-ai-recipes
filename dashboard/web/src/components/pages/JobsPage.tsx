'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, ChevronDown, Download, Trash2, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CodeBlock, Dialog, EmptyState, ErrorBox, Input, Select, Skeleton, Spinner, Stat, StatusPill } from '@/components/ui';
import { ago, classNames as cx, fmtNum, fmtDuration, shortId } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';

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

export function JobsPage() {
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
      setToast({ message: `Job ${deleteConfirm.name} deleted`, tone: 'ok' });
      setDeleteConfirm(null);
    } catch (e) {
      setToast({ message: `Error: ${(e as Error).message}`, tone: 'err' });
    }
  };

  if (jobsLoading && !jobs) return <Spinner label="Loading jobs…" />;

  return (
    <>
      <PageHeader title="Jobs" description="All Kubernetes batch Jobs in cluster" />

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
        <Stat label="Running" value={fmtNum(stats.running)} tone={stats.running > 0 ? 'info' : undefined} />
        <Stat label="Pending Pods" value={fmtNum(stats.pending)} tone={stats.pending > 0 ? 'warn' : undefined} />
        <Stat label="Succeeded" value={fmtNum(stats.succeeded)} tone="ok" />
        <Stat label="Failed" value={fmtNum(stats.failed)} tone={stats.failed > 0 ? 'err' : undefined} />
      </div>

      {jobsError && <ErrorBox error={jobsError} />}

      {/* Filter Bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={namespace} onChange={(e) => setNamespace(e.target.value)} className="w-40">
          <option value="">All Namespaces</option>
          {namespaces?.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </Select>
        <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-32">
          <option value="">All States</option>
          <option value="Running">Running</option>
          <option value="Succeeded">Succeeded</option>
          <option value="Failed">Failed</option>
          <option value="Pending">Pending</option>
        </Select>
        <Input placeholder="Search job, namespace, or image…" value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 min-w-40" />
      </div>

      {/* Jobs Table */}
      <Card title={`Jobs (${filteredJobs.length})`} className="mb-4">
        {!filteredJobs.length ? (
          <EmptyState title="No jobs found" hint={jobs?.length ? 'Try adjusting filters' : 'No jobs yet'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Namespace</th>
                  <th className="px-3 py-2 text-left font-medium">State</th>
                  <th className="px-3 py-2 text-center font-medium">Pods</th>
                  <th className="px-3 py-2 text-left font-medium">Queue / Priority</th>
                  <th className="px-3 py-2 text-center font-medium">GPU</th>
                  <th className="px-3 py-2 text-left font-medium">Image</th>
                  <th className="px-3 py-2 text-right font-medium">Age</th>
                  <th className="px-3 py-2 text-left font-medium">Duration</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
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
                            title="View logs"
                          >
                            <Zap size={14} className="text-fg-muted" />
                          </button>
                          {can(me, 'researcher') && (
                            <button
                              onClick={() => setDeleteConfirm(job)}
                              className="rounded px-2 py-1 hover:bg-red-500/10"
                              title="Delete job"
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
          title={`Logs: ${selectedJob.name}`}
          width="xl"
        >
          <LogViewer job={selectedJob} podIdx={selectedPodIdx} setPodIdx={setSelectedPodIdx} follow={logsFollow} setFollow={setLogsFollow} />
        </Dialog>
      )}

      {/* Delete Confirm Dialog */}
      {deleteConfirm && (
        <Dialog
          open={!!deleteConfirm}
          onClose={() => setDeleteConfirm(null)}
          title="Delete Job"
        >
          <div className="space-y-4">
            <p className="text-sm">
              Delete job <strong>{deleteConfirm.name}</strong> in <strong>{deleteConfirm.namespace}</strong>?
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setDeleteConfirm(null)} variant="secondary">
                Cancel
              </Button>
              <Button onClick={handleDelete} variant="danger">
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Cluster Events */}
      <Card title="Cluster Events" description={`Last 100 from namespace ${namespace || 'all'}`}>
        {eventsLoading ? (
          <Spinner />
        ) : !events?.length ? (
          <EmptyState title="No events" />
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
  const pods = job.pods ?? [];
  const pod = pods[podIdx];
  const [searchTerm, setSearchTerm] = React.useState('');
  const me = useMe();
  const [retained, setRetained] = React.useState(false);
  const logsUrl = pod ? `/api/k8s/pods/${job.namespace}/${pod.name}/logs?tail=1000${follow ? '&follow=1' : ''}${retained ? '&source=retained' : ''}` : '';

  const { data: logsData, isLoading, error: logsError } = useApi<{ source: string; phase?: string; lines: string[] }>(logsUrl, { refetch: follow ? 1000 : 0 });

  const filteredLines = React.useMemo(() => {
    if (!logsData?.lines) return [];
    if (!searchTerm) return logsData.lines;
    return logsData.lines.filter((line) => line.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [logsData?.lines, searchTerm]);

  if (!pod) return <EmptyState title="No pods" />;

  return (
    <div className="space-y-3">
      {/* Pod Selector */}
      <div className="flex gap-2 items-center">
        <span className="text-xs font-medium">Pod:</span>
        <select value={podIdx} onChange={(e) => setPodIdx(Number(e.target.value))} className="rounded border border-border bg-bg-elev px-2 py-1 text-xs">
          {pods.map((p, i) => (
            <option key={i} value={i}>
              {p.name} ({p.phase})
            </option>
          ))}
        </select>
      </div>
      {me.data?.role === 'admin' && <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input type="checkbox" checked={retained} onChange={event => setRetained(event.target.checked)} />
        기존 Kubernetes 작업의 현재 로그 보기 · 보관 이력과 비밀값 필터 없음
      </label>}
      <ErrorBox error={logsError} />

      {/* Log Viewer Controls */}
      <div className="flex gap-2 items-center">
        <Input
          placeholder="Search logs…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1 text-xs"
        />
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button
          onClick={() => {
            const text = filteredLines.join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${job.name}-${pod.name}.log`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="rounded p-1 hover:bg-bg-elev-2"
          title="Download logs"
        >
          <Download size={14} />
        </button>
      </div>

      {/* Logs Display */}
      <div className="bg-black rounded border border-border p-3 font-mono text-xs text-green-400 overflow-auto max-h-96">
        {isLoading ? (
          <Spinner />
        ) : !filteredLines.length ? (
          <div className="text-fg-muted">No logs</div>
        ) : (
          <div>
            {filteredLines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-fg-muted">
        Source: {logsData?.source} {logsData?.phase ? `• Phase: ${logsData.phase}` : ''}
      </div>
    </div>
  );
}
