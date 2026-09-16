'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CopyButton, EmptyState, ErrorBox, Spinner, Stat, StatusPill, Table, Toast } from '@/components/ui';
import { Sparkline } from '@/components/charts/Sparkline';
import { ago, classNames as cx, fmtNum, fmtUsd } from '@/lib/format';
import { useApi, useMe, can } from '@/lib/api-client';

interface OverviewData {
  features: { eks: boolean; slurm: boolean; amp: boolean; mlflow: boolean; pipeline: boolean; dcv: boolean; fsx: boolean };
  clusters: { name: string; orchestrator: 'eks' | 'slurm'; status?: string; groups: { name: string; isGpu: boolean; current: number; target: number }[] }[];
  nodes: { total: number; ready: number; gpuCapacity: number; gpuAllocatable: number; gpuUtilAvg?: string; error?: string };
  workflows: { total: number; byStatus: Record<string, number>; recent: { id: string; name: string; status: string; owner?: string; namespace?: string; createdAt: string; taskCount?: number; succeeded?: number }[] };
  queues: { clusterQueues: number; pendingWorkloads: number; admitted: number };
  recentEvents: { id?: string; workflowName: string; type?: string; reason?: string; message?: string; ts: string }[];
  cost?: { total: number; byService: { service: string; amount: number }[]; daily: number[] };
  controller?: { running: boolean; lastTick?: string; leased?: boolean; lastError?: string };
  errors: (string | undefined)[];
}

export function OverviewPage() {
  const me = useMe();
  const { data, isLoading, error } = useApi<OverviewData>('/api/overview', { refetch: 15000 });
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  if (isLoading && !data) return <Spinner label="Loading overview…" />;

  return (
    <>
      <PageHeader title="Overview" />
      <div className="space-y-4">
        {error && <ErrorBox error={error} />}

        {/* Top row: KPIs */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {data?.features.eks && (
            <Stat
              label="GPUs Allocatable"
              value={fmtNum(data.nodes.gpuAllocatable)}
              sub={data.nodes.gpuCapacity ? `of ${fmtNum(data.nodes.gpuCapacity)} capacity${data.nodes.gpuUtilAvg ? ` • ${data.nodes.gpuUtilAvg.slice(0, 5)}% util avg` : ''}` : undefined}
              tone={data.nodes.gpuAllocatable > 0 ? 'ok' : 'warn'}
            />
          )}
          <Stat label="Kubernetes Nodes Ready" value={`${data?.nodes.ready ?? 0}/${data?.nodes.total ?? 0}`} tone={data?.nodes.ready === data?.nodes.total ? 'ok' : 'warn'} />
          <Stat
            label="Workflows"
            value={fmtNum(data?.workflows.byStatus.RUNNING ?? 0)}
            sub={`running • ${fmtNum(data?.workflows.byStatus.PENDING ?? 0)} queued`}
          />
          {data?.features.eks && (
            <Stat
              label="Kueue Pending"
              value={fmtNum(data.queues.pendingWorkloads)}
              sub={`${fmtNum(data.queues.admitted)} admitted`}
              tone={data.queues.pendingWorkloads > 0 ? 'warn' : 'ok'}
            />
          )}
          {data?.features.eks && data?.cost && (
            <Stat
              label="30-Day Cost"
              value={fmtUsd(data.cost.total)}
              sub={
                data.cost.daily && data.cost.daily.length > 0 ? (
                  <Sparkline values={data.cost.daily} width={100} height={20} stroke="#6ea8fe" />
                ) : undefined
              }
            />
          )}
        </div>

        {/* Clusters Card */}
        <Card title="Clusters" description={`${data?.clusters.length ?? 0} total`}>
          {!data?.clusters.length ? (
            <EmptyState title="No clusters deployed" />
          ) : (
            <div className="space-y-2">
              {data.clusters.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-3 rounded border border-border bg-bg-elev-2 p-3">
                  <div className="min-w-0 flex-1">
                    <Link href="/compute" className="font-medium text-accent hover:underline">
                      {c.name}
                    </Link>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone="info">{c.orchestrator}</Badge>
                      {c.status && <StatusPill status={c.status} />}
                      {c.groups && c.groups.length > 0 && (
                        <span className="text-xs text-fg-muted">
                          {c.groups
                            .filter((g) => g.isGpu)
                            .map((g) => (
                              <span key={g.name} className="mr-2">
                                <Badge tone="accent">{g.name}</Badge> {g.current}/{g.target}
                              </span>
                            ))}
                          {c.groups.filter((g) => !g.isGpu).length > 0 && (
                            <span>
                              {c.groups
                                .filter((g) => !g.isGpu)
                                .map((g) => `${g.name} ${g.current}/${g.target}`)
                                .join(' · ')}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Recent workflows */}
        <Card title="Recent Workflows" description={`${data?.workflows.total ?? 0} total`}>
          {!data?.workflows.recent.length ? (
            <EmptyState title="No workflows yet" />
          ) : (
            <Table
              head={['Name', 'Status', 'Owner', 'Progress', 'Created']}
              dense
            >
              {data.workflows.recent.slice(0, 10).map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link href={`/workflows/${w.id}`} className="text-accent hover:underline">
                      {w.name}
                    </Link>
                  </td>
                  <td>
                    <StatusPill status={w.status} />
                  </td>
                  <td className="text-fg-muted">{w.owner ?? '—'}</td>
                  <td className="num">{w.succeeded ?? 0}/{w.taskCount ?? 0}</td>
                  <td className="text-fg-muted">{ago(w.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* Recent events */}
        <Card title="Recent Events" description={`Latest 15`}>
          {!data?.recentEvents.length ? (
            <EmptyState title="No recent events" />
          ) : (
            <div className="space-y-2">
              {data.recentEvents.map((e, i) => (
                <div key={i} className="flex items-start gap-3 border-l-2 border-border px-3 py-2 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-fg">
                      {e.workflowName} {e.reason && <span className="text-fg-muted">• {e.reason}</span>}
                    </div>
                    {e.message && <div className="mt-1 text-fg-muted">{e.message}</div>}
                  </div>
                  <div className="text-fg-faint">{ago(e.ts)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Cost by service */}
        {data?.features.eks && data?.cost && (
          <Card title="Cost by Service (30 days)" description="Top services">
            {!data.cost.byService.length ? (
              <EmptyState title="No cost data available" />
            ) : (
              <div className="space-y-3">
                {data.cost.byService.slice(0, 10).map((s) => {
                  const max = Math.max(...data.cost!.byService.map((x) => x.amount), 1);
                  return (
                    <div key={s.service}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-fg-muted">{s.service}</span>
                        <span className="num">{fmtUsd(s.amount)}</span>
                      </div>
                      <Bar value={s.amount} max={max} tone="accent" />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {/* Quick actions */}
        <Card title="Quick Actions">
          <div className="flex flex-wrap gap-2">
            <Link href="/workflows/new">
              <Button variant="primary">New Workflow</Button>
            </Link>
            {data?.features.eks && (
              <Link href="/compute">
                <Button>Scale GPU Nodes</Button>
              </Link>
            )}
            {data?.features.dcv && (
              <Link href="/sessions">
                <Button>Open DCV / Sessions</Button>
              </Link>
            )}
            <Link href="/datasets">
              <Button>Datasets</Button>
            </Link>
            {data?.features.amp && (
              <Link href="/metrics">
                <Button>Metrics</Button>
              </Link>
            )}
          </div>
        </Card>

        {/* Controller status footer */}
        {data?.controller && (
          <Card title="Controller Status" className="border-l-2 border-l-info">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div>
                <span className="text-fg-muted">Running:</span> <Badge tone={data.controller.running ? 'ok' : 'err'}>{data.controller.running ? 'Yes' : 'No'}</Badge>
              </div>
              {data.controller.lastTick && (
                <div>
                  <span className="text-fg-muted">Last tick:</span> <span className="num">{ago(data.controller.lastTick)}</span>
                </div>
              )}
              {data.controller.leased && (
                <div>
                  <Badge tone="accent">Leased mode</Badge>
                </div>
              )}
              {data.controller.lastError && (
                <ErrorBox error={new Error(data.controller.lastError)} className="mt-2" />
              )}
            </div>
          </Card>
        )}

        {/* Global errors */}
        {data?.errors && data.errors.length > 0 && (
          <div className="space-y-2">
            {data.errors.filter(Boolean).map((e, i) => (
              <ErrorBox key={i} error={new Error(e!)} />
            ))}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
