'use client';
import * as React from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CodeBlock, Dialog, EmptyState, ErrorBox, Input, KeyValue, Spinner, Table } from '@/components/ui';
import { fmtNum, parseQuantity, classNames as cx } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';
import { useT } from '@/lib/i18n';

interface ClusterQueue {
  name: string;
  cohort: string;
  pending: number;
  admitted: number;
  reserving: number;
  preemption?: { rules?: Array<{ order: number; podPriority?: { name: string }; clusterQueuePriority?: { name: string } }> };
  fairShareWeight?: number;
  weightedShare?: number;
  quotas: Array<{ flavor: string; resource: string; nominal?: string; borrowingLimit?: string; lendingLimit?: string }>;
  usage: Array<{ flavor: string; resource: string; total?: string; borrowed?: string }>;
  conditions?: Array<{ message?: string; reason?: string }>;
}

interface LocalQueue {
  name: string;
  namespace: string;
  clusterQueue: string;
  pending: number;
  admitted: number;
}

interface Flavor {
  name: string;
  nodeLabels: Record<string, string>;
}

interface PriorityClass {
  name: string;
  value: number;
  description: string;
}

interface Workload {
  name: string;
  namespace: string;
  queue: string;
  priorityClass?: string;
  priority?: number;
  state: string;
  clusterQueue?: string;
  created: string;
  active: boolean;
  message?: string;
  podSets?: Array<{ name: string; count: number }>;
  usage?: string[];
}

interface QueuesData {
  clusterQueues: ClusterQueue[];
  localQueues: LocalQueue[];
  flavors: Flavor[];
  priorityClasses: PriorityClass[];
  workloads: Workload[];
}

interface QuotasData {
  clusterArn: string;
  quotas: any[];
  policies: any[];
}

interface ClusterSummary {
  name: string;
  orchestrator: 'eks' | 'slurm';
  groups: { name: string; instanceType: string; current: number; target: number; isGpu?: boolean; gpuCount?: number }[];
}

export function QueuesPage() {
  const t = useT('queues');
  const tc = useT('common');
  const { data: me } = useMe();
  const [hideFinished, setHideFinished] = React.useState(false);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [newQuotaDialog, setNewQuotaDialog] = React.useState(false);
  const [newPolicyDialog, setNewPolicyDialog] = React.useState(false);
  const [deleteItem, setDeleteItem] = React.useState<{ id: string; kind: 'quota' | 'policy' } | null>(null);

  const { data: queuesData, isLoading: queuesLoading, error: queuesError } = useApi<QueuesData>('/api/queues', { refetch: 8000 });
  const { data: quotasData, isLoading: quotasLoading, error: quotasError } = useApi<QuotasData>('/api/quotas', { refetch: 8000 });

  const { mutate: deleteQuotaMutation } = useApiMutation(
    (item: { id: string; kind: 'quota' | 'policy' }) =>
      fetch(`/api/quotas?id=${item.id}&kind=${item.kind}`, { method: 'DELETE' }).then((r) => (r.ok ? { ok: true } : r.json().then((e) => Promise.reject(e)))),
    ['/api/quotas'],
  );

  const handleDeleteQuota = async () => {
    if (!deleteItem) return;
    try {
      await deleteQuotaMutation(deleteItem);
      setToast({ message: t('deleted', { kind: deleteItem.kind }), tone: 'ok' });
      setDeleteItem(null);
    } catch (e) {
      setToast({ message: t('deleteError', { message: (e as Error).message }), tone: 'err' });
    }
  };

  const filteredWorkloads = React.useMemo(() => {
    const wls = queuesData?.workloads ?? [];
    if (hideFinished) return wls.filter((w) => w.state !== 'finished' && w.state !== 'Finished');
    return wls;
  }, [queuesData?.workloads, hideFinished]);

  if ((queuesLoading || quotasLoading) && !queuesData) return <Spinner label={t('loadingQueues')} />;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />

      {/* Toast */}
      {toast && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-bg-elev-2 p-3 text-sm">
          <div className={`flex-1 ${toast.tone === 'err' ? 'text-err' : 'text-ok'}`}>{toast.message}</div>
          <button onClick={() => setToast(null)} className="text-fg-muted">
            ×
          </button>
        </div>
      )}

      {queuesError && <ErrorBox error={queuesError} />}
      {quotasError && <ErrorBox error={quotasError} />}

      {/* Explainer */}
      <Card className="mb-4 bg-blue-500/5 border-blue-500/20">
        <div className="px-4 py-3 text-xs text-fg-muted flex gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5 text-accent" />
          <p>
            {t('explainer', { ns: 'hyperpod-ns-<team>' })}
          </p>
        </div>
      </Card>

      {/* Kueue Cluster Queues */}
      <div className="space-y-4 mb-4">
        {(queuesData?.clusterQueues ?? []).map((cq) => (
          <Card key={cq.name} title={cq.name} className="border-border">
            <div className="space-y-4 px-4 py-3">
              {/* Status Row */}
              <div className="flex items-center gap-4 text-sm">
                <div className="flex gap-2">
                  {cq.cohort && <Badge tone="info">{cq.cohort}</Badge>}
                </div>
                <div className="flex gap-6 text-xs">
                  <div>
                    <span className="text-fg-muted">{t('pending')}:</span> <span className="font-medium">{cq.pending}</span>
                  </div>
                  <div>
                    <span className="text-fg-muted">{t('admitted')}:</span> <span className="font-medium">{cq.admitted}</span>
                  </div>
                  <div>
                    <span className="text-fg-muted">{t('reserving')}:</span> <span className="font-medium">{cq.reserving}</span>
                  </div>
                  {cq.fairShareWeight && (
                    <div>
                      <span className="text-fg-muted">{t('fairShare')}:</span> <span className="font-medium">{cq.fairShareWeight}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Usage Table */}
              {(cq.quotas?.length ?? 0) > 0 && (
                <div className="overflow-x-auto">
                  <table className="tbl w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-2 py-1.5 text-left font-medium">{t('flavor')}</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t('resource')}</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t('quota')}</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t('usageBorrowed')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {cq.quotas.map((q, i) => {
                        const usage = cq.usage?.find((u) => u.flavor === q.flavor && u.resource === q.resource);
                        const nominal = parseQuantity(q.nominal);
                        const used = parseQuantity(usage?.total);
                        const borrowed = parseQuantity(usage?.borrowed);
                        const pct = nominal > 0 ? ((used ?? 0) / nominal) * 100 : 0;

                        return (
                          <tr key={i} className="hover:bg-bg-elev-2">
                            <td className="px-2 py-1.5">{q.flavor}</td>
                            <td className="px-2 py-1.5 mono text-fg-muted">{q.resource}</td>
                            <td className="px-2 py-1.5">{q.nominal ?? '—'}</td>
                            <td className="px-2 py-1.5">
                              <div className="space-y-1">
                                <Bar value={used ?? 0} max={nominal} label={<span className="text-fg-muted text-xs">{usage?.total ?? '—'} {borrowed ? <span className="text-amber-400"> (+ {usage?.borrowed} {t('borrowed')})</span> : ''}</span>} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Preemption / Conditions */}
              {(cq.conditions?.length ?? 0) > 0 && (
                <div className="border-t border-border pt-3">
                  {cq.conditions?.map((cond, i) => (
                    <div key={i} className="text-xs text-fg-muted mb-1">
                      {cond.reason}: {cond.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* Local Queues */}
      <Card title={t('localQueues')} className="mb-4">
        {!queuesData?.localQueues?.length ? (
          <EmptyState title={t('noLocalQueues')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">{tc('name')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('namespace')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('clusterQueue')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('pending')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('admitted')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {queuesData.localQueues.map((lq) => (
                  <tr key={`${lq.namespace}/${lq.name}`} className="hover:bg-bg-elev-2">
                    <td className="px-3 py-2 mono text-fg-muted">{lq.name}</td>
                    <td className="px-3 py-2">{lq.namespace}</td>
                    <td className="px-3 py-2">{lq.clusterQueue}</td>
                    <td className="px-3 py-2 text-center">{lq.pending}</td>
                    <td className="px-3 py-2 text-center">{lq.admitted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Priority Classes */}
      <Card title={t('priorityClasses')} className="mb-4">
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {(queuesData?.priorityClasses ?? []).map((pc) => (
            <div key={pc.name} title={pc.description}>
              <Badge>
                {pc.name} ({pc.value})
              </Badge>
            </div>
          ))}
        </div>
      </Card>

      {/* Flavors */}
      <Card title={t('flavors')} className="mb-4">
        {!queuesData?.flavors?.length ? (
          <EmptyState title={t('noFlavors')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">{tc('name')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('nodeLabels')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {queuesData.flavors.map((f) => (
                  <tr key={f.name} className="hover:bg-bg-elev-2">
                    <td className="px-3 py-2 mono text-fg-muted">{f.name}</td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(f.nodeLabels ?? {}).map(([k, v]) => (
                          <Badge key={k} tone="info">
                            {k}={v}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Workloads */}
      <Card
        title={`${t('workloads')} (${filteredWorkloads.length})`}
        actions={
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={hideFinished} onChange={(e) => setHideFinished(e.target.checked)} />
            {t('hideFinished')}
          </label>
        }
        className="mb-4"
      >
        {!filteredWorkloads?.length ? (
          <EmptyState title={t('noWorkloads')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">{tc('name')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('namespace')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('queue')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('priority')}</th>
                  <th className="px-3 py-2 text-left font-medium">{tc('state')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('clusterQueue')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('usage')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredWorkloads.map((w) => (
                  <tr key={`${w.namespace}/${w.name}`} className="hover:bg-bg-elev-2">
                    <td className="px-3 py-2 mono text-fg-muted">{w.name}</td>
                    <td className="px-3 py-2">{w.namespace}</td>
                    <td className="px-3 py-2">{w.queue}</td>
                    <td className="px-3 py-2">
                      {w.priorityClass} {w.priority && <span className="text-fg-muted">({w.priority})</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={w.state === 'admitted' ? 'ok' : w.state === 'pending' ? 'warn' : 'info'}>{w.state}</Badge>
                    </td>
                    <td className="px-3 py-2">{w.clusterQueue || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(w.usage ?? []).map((u, i) => (
                          <Badge key={i} tone="info">
                            {u}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* SageMaker Task Governance */}
      {quotasData && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium">{t('sagemaker')}</h2>

          {/* Policies */}
          {quotasData.policies?.length > 0 && (
            <div className="grid gap-4">
              {quotasData.policies.map((policy) => (
                <Card key={policy.ClusterSchedulerConfigId} title={policy.Name}>
                  <div className="space-y-3 px-4 py-3">
                    <div className="text-xs">
                      {tc('status')}: <Badge tone={policy.Status === 'ACTIVE' ? 'ok' : 'warn'}>{policy.Status}</Badge>
                    </div>
                    {policy.detail?.SchedulerConfig && (
                      <>
                        <div>
                          <h4 className="text-xs font-medium mb-2">{t('priorityClasses')}</h4>
                          <div className="flex flex-wrap gap-2">
                            {policy.detail.SchedulerConfig.PriorityClasses?.map((pc: any) => (
                              <Badge key={pc.Name}>
                                {pc.Name} ({pc.Weight})
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="text-xs">
                          {t('fairShare')}: <span className="font-medium">{policy.detail.SchedulerConfig.FairShare ? t('enabled') : t('disabled')}</span>
                        </div>
                      </>
                    )}
                    {can(me, 'admin') && (
                      <button
                        onClick={() => setDeleteItem({ id: policy.ClusterSchedulerConfigId, kind: 'policy' })}
                        className="text-xs text-err hover:underline"
                      >
                        {tc('delete')}
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Quotas */}
          {quotasData.quotas?.length > 0 && (
            <Card title={t('quotas')}>
              <div className="overflow-x-auto">
                <table className="tbl w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left font-medium">{tc('name')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('team')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('instances')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('borrowLimit')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('preempt')}</th>
                      <th className="px-3 py-2 text-left font-medium">{tc('status')}</th>
                      {can(me, 'admin') && <th className="px-3 py-2 text-center font-medium">{tc('actions')}</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {quotasData.quotas.map((q) => (
                      <tr key={q.ComputeQuotaId} className="hover:bg-bg-elev-2">
                        <td className="px-3 py-2 mono text-fg-muted">{q.Name}</td>
                        <td className="px-3 py-2">{q.ComputeQuotaTarget?.TeamName || '—'}</td>
                        <td className="px-3 py-2 text-xs flex flex-wrap gap-1">
                          {q.detail?.ComputeQuotaConfig?.ComputeQuotaResources?.map((r: any) => (
                            <Badge key={r.InstanceType} tone="info">
                              {r.InstanceType}: {r.Count}
                            </Badge>
                          ))}
                        </td>
                        <td className="px-3 py-2">{q.detail?.ComputeQuotaConfig?.ResourceSharingConfig?.BorrowLimit ?? '—'}%</td>
                        <td className="px-3 py-2">{q.detail?.ComputeQuotaConfig?.PreemptTeamTasks ? t('yes') : t('no')}</td>
                        <td className="px-3 py-2">
                          <Badge tone={q.Status === 'ACTIVE' ? 'ok' : 'warn'}>{q.Status}</Badge>
                        </td>
                        {can(me, 'admin') && (
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => setDeleteItem({ id: q.ComputeQuotaId, kind: 'quota' })}
                              className="text-err hover:underline"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Admin Actions */}
          {can(me, 'admin') && (
            <div className="flex gap-2">
              <Button onClick={() => setNewQuotaDialog(true)} variant="primary">
                <Plus size={14} />
                {t('newComputeQuota')}
              </Button>
              <Button onClick={() => setNewPolicyDialog(true)} variant="primary">
                <Plus size={14} />
                {t('newClusterPolicy')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Delete Confirm Dialog */}
      {deleteItem && (
        <Dialog open={!!deleteItem} onClose={() => setDeleteItem(null)} title={tc('delete')}>
          <div className="space-y-4">
            <p className="text-sm">{t('deleteThisKind', { kind: deleteItem.kind })}</p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setDeleteItem(null)} variant="secondary">
                {tc('cancel')}
              </Button>
              <Button onClick={handleDeleteQuota} variant="danger">
                {tc('delete')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* New Quota Dialog */}
      {newQuotaDialog && (
        <NewQuotaDialog
          onClose={() => setNewQuotaDialog(false)}
          onSuccess={() => {
            setNewQuotaDialog(false);
            setToast({ message: t('quotaCreated'), tone: 'ok' });
          }}
          onError={(e) => setToast({ message: `Error: ${e}`, tone: 'err' })}
        />
      )}

      {/* New Policy Dialog */}
      {newPolicyDialog && (
        <NewPolicyDialog
          onClose={() => setNewPolicyDialog(false)}
          onSuccess={() => {
            setNewPolicyDialog(false);
            setToast({ message: t('policyCreated'), tone: 'ok' });
          }}
          onError={(e) => setToast({ message: `Error: ${e}`, tone: 'err' })}
        />
      )}
    </>
  );
}

function NewQuotaDialog({ onClose, onSuccess, onError }: { onClose: () => void; onSuccess: () => void; onError: (e: string) => void }) {
  const t = useT('queues');
  const tc = useT('common');
  const [name, setName] = React.useState('');
  const [team, setTeam] = React.useState('');
  const [fairShare, setFairShare] = React.useState(50);
  const [instances, setInstances] = React.useState<Array<{ instanceType: string; count: string }>>([{ instanceType: '', count: '1' }]);
  const [borrowLimit, setBorrowLimit] = React.useState('100');
  const [preempt, setPreempt] = React.useState('LowerPriority');
  const [loading, setLoading] = React.useState(false);
  const { data: clusterData, isLoading: clustersLoading } = useApi<{ clusters: ClusterSummary[] }>('/api/clusters');

  // Instance types offered are exactly those present in the HyperPod EKS cluster's instance groups (DescribeCluster).
  const eksGroups = React.useMemo(() => clusterData?.clusters.find((c) => c.orchestrator === 'eks')?.groups ?? [], [clusterData]);
  const instanceTypeOptions = React.useMemo(() => [...new Set(eksGroups.map((g) => g.instanceType).filter(Boolean))], [eksGroups]);
  const defaultInstanceType = React.useMemo(() => {
    const gpu = eksGroups.find((g) => (g.gpuCount ?? (g.isGpu ? 1 : 0)) > 0)?.instanceType;
    return gpu ?? instanceTypeOptions[0];
  }, [eksGroups, instanceTypeOptions]);
  React.useEffect(() => {
    if (defaultInstanceType) setInstances((rows) => (rows.length === 1 && rows[0].instanceType === '' ? [{ instanceType: defaultInstanceType, count: rows[0].count }] : rows));
  }, [defaultInstanceType]);

  const handleSubmit = async () => {
    if (!name || !team || instances.some((i) => !i.instanceType || !i.count)) {
      onError(tc('required'));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/quotas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'quota',
          name,
          team,
          fairShareWeight: fairShare,
          instances: instances.map((i) => ({ instanceType: i.instanceType, count: Number(i.count) })),
          borrowLimit: Number(borrowLimit) || undefined,
          preempt: preempt as 'LowerPriority' | 'Never',
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || res.statusText);
      }
      onSuccess();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title={t('newComputeQuota')}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">{t('quotaName')}</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-team-quota" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">{t('teamName')}</label>
          <Input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="team-a" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">{t('fairShareWeight')}</label>
          <Input type="number" value={fairShare} onChange={(e) => setFairShare(Number(e.target.value))} min={0} max={100} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-2">{t('instances')}</label>
          {!instanceTypeOptions.length && !clustersLoading && (
            <div className="mb-2 text-xs text-fg-muted">{t('clusterInstancesUnavailable')}</div>
          )}
          {instances.map((inst, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <select
                value={inst.instanceType}
                onChange={(e) => {
                  const newInsts = [...instances];
                  newInsts[i].instanceType = e.target.value;
                  setInstances(newInsts);
                }}
                disabled={!instanceTypeOptions.length}
                className="rounded border border-border bg-bg-elev px-2 py-1 text-xs flex-1 disabled:opacity-50"
              >
                <option value="">{clustersLoading ? t('loading') : instanceTypeOptions.length ? t('selectInstanceType') : t('noInstanceTypes')}</option>
                {instanceTypeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                value={inst.count}
                onChange={(e) => {
                  const newInsts = [...instances];
                  newInsts[i].count = e.target.value;
                  setInstances(newInsts);
                }}
                placeholder={t('count')}
                min={0}
                className="w-20"
              />
              {instances.length > 1 && (
                <button
                  onClick={() => setInstances(instances.filter((_, j) => j !== i))}
                  className="px-2 py-1 rounded hover:bg-red-500/10 text-err"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => setInstances([...instances, { instanceType: defaultInstanceType ?? '', count: '1' }])}
            disabled={!instanceTypeOptions.length}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            {t('addInstanceType')}
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">{t('borrowLimitPercent')}</label>
          <Input type="number" value={borrowLimit} onChange={(e) => setBorrowLimit(e.target.value)} min={0} max={500} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">{t('preemption')}</label>
          <select
            value={preempt}
            onChange={(e) => setPreempt(e.target.value)}
            className="w-full rounded border border-border bg-bg-elev px-2 py-1 text-xs"
          >
            <option value="LowerPriority">{t('lowerPriority')}</option>
            <option value="Never">{t('never')}</option>
          </select>
        </div>

        <p className="text-xs text-fg-muted">
          {t('quotaAutoCreates', { team })}
        </p>

        <div className="flex gap-2 justify-end">
          <Button onClick={onClose} variant="secondary">
            {tc('cancel')}
          </Button>
          <Button onClick={handleSubmit} variant="primary" loading={loading}>
            {tc('create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function NewPolicyDialog({ onClose, onSuccess, onError }: { onClose: () => void; onSuccess: () => void; onError: (e: string) => void }) {
  const t = useT('queues');
  const tc = useT('common');
  const [name, setName] = React.useState('');
  const [priorityClasses, setPriorityClasses] = React.useState<Array<{ name: string; weight: string }>>([
    { name: 'training', weight: '100' },
    { name: 'inference', weight: '70' },
    { name: 'background', weight: '10' },
  ]);
  const [fairShare, setFairShare] = React.useState(true);
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async () => {
    if (!name || priorityClasses.some((p) => !p.name || !p.weight)) {
      onError(t('fillAllFields'));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/quotas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'policy',
          name,
          priorityClasses: priorityClasses.map((p) => ({ name: p.name, weight: Number(p.weight) })),
          fairShare,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || res.statusText);
      }
      onSuccess();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title={t('newClusterPolicy')}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">{t('policyName')}</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="default-policy" />
        </div>

        <div>
          <label className="block text-xs font-medium mb-2">{t('priorityClasses')}</label>
          {priorityClasses.map((pc, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <Input
                value={pc.name}
                onChange={(e) => {
                  const newPcs = [...priorityClasses];
                  newPcs[i].name = e.target.value;
                  setPriorityClasses(newPcs);
                }}
                placeholder={t('className')}
                className="flex-1"
              />
              <Input
                type="number"
                value={pc.weight}
                onChange={(e) => {
                  const newPcs = [...priorityClasses];
                  newPcs[i].weight = e.target.value;
                  setPriorityClasses(newPcs);
                }}
                placeholder={t('weight')}
                min={0}
                max={100}
                className="w-24"
              />
            </div>
          ))}
          <button
            onClick={() => setPriorityClasses([...priorityClasses, { name: '', weight: '50' }])}
            className="text-xs text-accent hover:underline"
          >
            {t('addClass')}
          </button>
        </div>

        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input type="checkbox" checked={fairShare} onChange={(e) => setFairShare(e.target.checked)} />
          {t('fairShareEnable')}
        </label>

        <div className="flex gap-2 justify-end">
          <Button onClick={onClose} variant="secondary">
            {tc('cancel')}
          </Button>
          <Button onClick={handleSubmit} variant="primary" loading={loading}>
            {tc('create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
