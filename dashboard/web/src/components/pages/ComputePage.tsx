'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Tabs, Toast } from '@/components/ui';
import { fmtBytes, shortId } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';
import { ScaleControls } from '@/components/compute/ScaleControls';
import { NodeActions } from '@/components/compute/NodeActions';
import { ResourceStrip } from '@/components/layout/ResourceStrip';

interface ClusterSummary {
  name: string;
  orchestrator: 'eks' | 'slurm';
  status?: string;
  arn?: string;
  createdAt?: string;
  failureMessage?: string;
  nodeRecovery?: string;
  groups: {
    name: string;
    instanceType: string;
    current: number;
    target: number;
    status?: string;
    gpuCount?: number;
    vCpu?: number;
    memoryGiB?: number;
    gpuName?: string;
    role?: 'controller' | 'login' | 'worker';
    isGpu?: boolean;
  }[];
  nodes: { id: string; group: string; instanceType: string; status: string; launchTime?: string }[];
  events?: { EventId?: string; EventTime?: string; ResourceType?: string; Description?: string }[];
}

interface ClusterResponse {
  clusters: ClusterSummary[];
  k8sNodes: { name: string; instanceId?: string; instanceType?: string; group?: string; health?: string; ready: boolean; gpuCapacity: number; gpuAllocatable: number; cpu?: string; memory?: string; kubelet?: string; taints: string[]; unschedulable: boolean }[];
  addons: { name: string; version?: string; status?: string; health: number }[];
  events?: { EventId?: string; EventTime?: string; ResourceType?: string; Description?: string }[];
}

interface FileSystem {
  id: string;
  label: string;
  lifecycle?: string;
  storageCapacityGiB?: number;
  dnsName?: string;
  mountName?: string;
  associations: { id?: string; fileSystemPath?: string; dataRepositoryPath?: string; lifecycle?: string }[];
}

interface DataRepositoryTask {
  TaskId?: string;
  Lifecycle?: string;
  CreationTime?: string;
  Paths?: string[];
  Type?: string;
}

export function ComputePage() {
  const t = useT('compute');
  const ts = useT('scaling');
  const tc = useT('common');
  const tr = useT('resources');
  const { fmtTime, ago } = useFormat();
  const me = useMe();
  const [activeTab, setActiveTab] = React.useState<'eks' | 'slurm'>('eks');
  const [scaleDialog, setScaleDialog] = React.useState<{ cluster: string; group: string; current: number } | null>(null);
  const [exportDialog, setExportDialog] = React.useState<{ fileSystemId: string } | null>(null);
  const [exportPaths, setExportPaths] = React.useState<string>('/fsx/checkpoints');
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [nodeRecoveryDialog, setNodeRecoveryDialog] = React.useState<{ cluster: string; instanceId: string; action: 'reboot' | 'replace' } | null>(null);

  const clustersResp = useApi<ClusterResponse>('/api/clusters', { refetch: 10000 });
  const fsxResp = useApi<FileSystem[]>('/api/fsx', { refetch: 10000 });

  const exportFsxMutation = useApiMutation(
    async (params: { fileSystemId: string; paths: string[] }) => {
      const res = await fetch('/api/fsx/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileSystemId: params.fileSystemId,
          type: 'EXPORT_TO_REPOSITORY',
          paths: params.paths,
        }),
      });
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
      return res.json();
    },
    ['/api/fsx/tasks'],
  );

  const handleScaleClick = (cluster: string, group: string, current: number) => {
    setScaleDialog({ cluster, group, current });
  };

  const handleExportClick = (fileSystemId: string) => {
    setExportDialog({ fileSystemId });
    setExportPaths('/fsx/checkpoints');
  };

  const handleExportApply = async () => {
    if (!exportDialog) return;
    const paths = exportPaths.split('\n').map((p) => p.trim()).filter(Boolean);
    if (!paths.length) {
      setToast({ message: t('pathsRequired'), tone: 'err' });
      return;
    }
    try {
      await exportFsxMutation.mutateAsync({ fileSystemId: exportDialog.fileSystemId, paths });
      setToast({ message: t('exportSuccess', { count: paths.length }), tone: 'ok' });
      setExportDialog(null);
    } catch (e) {
      setToast({ message: t('exportFailed', { message: (e as Error).message }), tone: 'err' });
    }
  };

  const clusters = clustersResp.data?.clusters ?? [];
  const k8sNodes = clustersResp.data?.k8sNodes ?? [];
  const addons = clustersResp.data?.addons ?? [];
  const fileSystems = fsxResp.data ?? [];

  const res = me.data?.resources;
  const eksCluster = clusters.find((c) => c.orchestrator === 'eks');
  const slurmCluster = clusters.find((c) => c.orchestrator === 'slurm');

  const showTab = eksCluster || slurmCluster;
  const activeCluster = activeTab === 'eks' ? eksCluster : slurmCluster;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('hyperPodCluster'), value: res?.hyperPodEks?.clusterName, console: res?.hyperPodEks ? { kind: 'hyperpod-cluster', name: res.hyperPodEks.clusterName } : undefined },
          { label: tr('hyperPodSlurm'), value: res?.hyperPodSlurm?.clusterName, console: res?.hyperPodSlurm ? { kind: 'hyperpod-cluster', name: res.hyperPodSlurm.clusterName } : undefined },
          { label: tr('eksCluster'), value: res?.hyperPodEks?.eksClusterName, console: res?.hyperPodEks ? { kind: 'eks-cluster', name: res.hyperPodEks.eksClusterName } : undefined },
          { label: tr('fsx'), value: res?.fsx?.fileSystemId, console: res?.fsx ? { kind: 'fsx-filesystem', id: res.fsx.fileSystemId } : undefined },
          { label: tr('clusterLogGroup'), value: res?.hyperPodEks?.logGroupPrefix, console: res?.hyperPodEks ? { kind: 'log-group', name: res.hyperPodEks.logGroupPrefix } : undefined },
        ]}
      />
      <div className="space-y-4">
        {clustersResp.error && <ErrorBox error={clustersResp.error} />}

        {showTab && (
          <Tabs
            value={activeTab}
            onChange={setActiveTab}
            items={[
              ...(eksCluster ? [{ id: 'eks' as const, label: t('eks'), count: clusters.filter((c) => c.orchestrator === 'eks').length }] : []),
              ...(slurmCluster ? [{ id: 'slurm' as const, label: t('slurm'), count: clusters.filter((c) => c.orchestrator === 'slurm').length }] : []),
            ]}
          />
        )}

        {/* Cluster detail */}
        {activeCluster && (
          <>
            {/* Cluster header */}
            <Card>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">{activeCluster.name}</h3>
                  {activeCluster.status && <StatusPill status={activeCluster.status} className="mt-2" />}
                  {activeCluster.nodeRecovery && (
                    <div className="mt-2">
                      <Badge tone={activeCluster.nodeRecovery === 'Automatic' ? 'ok' : 'warn'}>
                        {activeCluster.nodeRecovery === 'Automatic' ? t('nodeRecoveryAutomatic') : t('nodeRecoveryDisabled')}
                      </Badge>
                    </div>
                  )}
                  {activeCluster.failureMessage && <ErrorBox error={new Error(activeCluster.failureMessage)} className="mt-2" />}
                </div>
                <div className="flex-1">
                  <div className="text-xs text-fg-muted mb-1">{t('clusterArn')}</div>
                  <div className="flex items-center gap-2">
                    <code className="mono text-[11px] text-fg-faint">{shortId(activeCluster.arn, 80)}</code>
                    {activeCluster.arn && <CopyButton text={activeCluster.arn} />}
                  </div>
                </div>
              </div>
              {activeCluster.createdAt && (
                <div className="mt-3 text-xs text-fg-muted">
                  {t('created')}: <span>{fmtTime(activeCluster.createdAt)}</span>
                </div>
              )}
            </Card>

            {/* Instance Groups */}
            <Card title={t('instGroups')}>
              {activeCluster.groups.length === 0 ? (
                <EmptyState title={t('noGroups')} />
              ) : (
                <Table
                  head={[t('groupName'), 'Details', t('current'), tc('status'), can(me.data, 'admin') ? t('capacityPlan') : '']}
                  dense
                >
                  {activeCluster.groups.map((g) => (
                    <tr key={g.name}>
                      <td className="font-medium">
                        <div>{g.name}</div>
                        {g.role && <Badge tone="info" className="mt-1">{g.role}</Badge>}
                      </td>
                      <td className="text-xs">
                        <div className="space-y-1">
                          <div>{g.instanceType}</div>
                          <div className="text-fg-muted">
                            {[
                              g.vCpu && `${g.vCpu} vCPU`,
                              g.memoryGiB && `${g.memoryGiB.toFixed(0)} GB`,
                              g.gpuCount !== undefined && g.gpuCount > 0 && `GPU ${g.gpuCount}× ${g.gpuName || 'N/A'}`,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                      </td>
                      <td>
                        <Bar value={g.current} max={g.target || 1} label={`${g.current} / ${g.target}`} />
                      </td>
                      <td>{g.status && <StatusPill status={g.status} />}</td>
                      <td>
                        {can(me.data, 'admin') ? (
                          <Button size="sm" variant="ghost" onClick={() => handleScaleClick(activeCluster.name, g.name, g.target)}>
                            {ts('openButton')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            {/* HyperPod instances (SageMaker ListClusterNodes) — the only node view for Slurm clusters */}
            <Card title={t('hpNodes')}>
              {activeCluster.nodes.length === 0 ? <EmptyState title={t('noHpNodes')} /> : (
                <Table head={[t('instanceId'), t('group'), t('instType'), tc('status'), t('launchTime'), can(me.data, 'admin') ? tc('actions') : '']} dense>
                  {activeCluster.nodes.map((n) => (
                    <tr key={n.id}>
                      <td className="mono text-[11px]">{n.id}</td>
                      <td className="text-xs text-fg-muted">{n.group}</td>
                      <td className="text-xs">{n.instanceType}</td>
                      <td><StatusPill status={n.status} /></td>
                      <td className="text-xs text-fg-muted">{n.launchTime ? fmtTime(n.launchTime) : '—'}</td>
                      {can(me.data, 'admin') && (
                        <td>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setNodeRecoveryDialog({ cluster: activeCluster.name, instanceId: n.id, action: 'reboot' })}>{t('nodeReboot')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setNodeRecoveryDialog({ cluster: activeCluster.name, instanceId: n.id, action: 'replace' })}>{t('nodeReplace')}</Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            {/* K8s Nodes */}
            {activeTab === 'eks' && (
              <Card title={t('nodes')}>
                {k8sNodes.length === 0 ? (
                  <EmptyState title={t('noNodes')} />
                ) : (
                  <Table
                    head={[t('node'), t('group'), tc('status'), t('gpu'), t('health'), t('kubelet'), t('taints'), can(me.data, 'admin') ? tc('actions') : '']}
                    dense
                  >
                    {k8sNodes.map((n) => (
                      <tr key={n.name}>
                        <td className="mono text-[11px]">{n.name}</td>
                        <td className="text-xs text-fg-muted">{n.group ?? '—'}</td>
                        <td>
                          <Badge tone={n.ready ? 'ok' : 'err'}>{n.ready ? t('ready') : t('notReady')}</Badge>
                        </td>
                        <td className="num">{n.gpuAllocatable}/{n.gpuCapacity}</td>
                        <td>
                          {n.health && (
                            <Badge tone={n.health === 'Schedulable' && !n.unschedulable ? 'ok' : 'err'}>
                              {n.unschedulable ? t('cordoned') : n.health === 'Schedulable' ? t('schedulable') : n.health}
                            </Badge>
                          )}
                        </td>
                        <td className="text-xs text-fg-muted">{shortId(n.kubelet, 12)}</td>
                        <td className="text-xs text-fg-muted">{n.taints.length > 0 ? n.taints.join(', ') : '—'}</td>
                        {can(me.data, 'admin') && eksCluster && (
                          <td>
                            {n.instanceId ? (
                              <div className="flex gap-1">
                                <Button size="sm" variant="ghost" onClick={() => setNodeRecoveryDialog({ cluster: eksCluster.name, instanceId: n.instanceId!, action: 'reboot' })}>{t('nodeReboot')}</Button>
                                <Button size="sm" variant="ghost" onClick={() => setNodeRecoveryDialog({ cluster: eksCluster.name, instanceId: n.instanceId!, action: 'replace' })}>{t('nodeReplace')}</Button>
                              </div>
                            ) : <span className="text-xs text-fg-faint">—</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}

            {/* Cluster Events */}
            {activeCluster.events && activeCluster.events.length > 0 && (
              <Card title={t('events')} description={t('latest')}>
                <div className="space-y-2">
                  {activeCluster.events.slice(0, 25).map((e, i) => (
                    <div key={i} className="border-l-2 border-border px-3 py-2 text-xs">
                      <div className="font-medium text-fg">{e.ResourceType}</div>
                      {e.Description && <div className="mt-1 text-fg-muted">{e.Description}</div>}
                      {e.EventTime && <div className="mt-1 text-fg-faint">{fmtTime(e.EventTime)}</div>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* EKS Add-ons */}
            {activeTab === 'eks' && (
              <Card title={t('addons')}>
                {addons.length === 0 ? (
                  <EmptyState title={t('noAddons')} />
                ) : (
                  <Table head={[t('addon'), t('version'), tc('status'), t('health')]} dense>
                    {addons.map((a) => (
                      <tr key={a.name}>
                        <td className="font-medium">{a.name}</td>
                        <td className="text-fg-muted">{a.version ?? '—'}</td>
                        <td>{a.status && <StatusPill status={a.status} />}</td>
                        <td className="num">{a.health > 0 ? <Badge tone="err">{t('issues', { count: a.health })}</Badge> : <Badge tone="ok">{t('healthy')}</Badge>}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}

            {/* Connect Instructions */}
            <Card title={t('connect')}>
              {activeTab === 'eks' ? (
                <div className="space-y-3">
                  <div>
                    {me.data?.region && me.data?.clusters.eksName ? (
                      <>
                        <div className="mb-2 text-xs font-medium text-fg-muted">{t('updateKubeconfig')}:</div>
                        <CodeBlock
                          code={`aws eks update-kubeconfig --name ${me.data.clusters.eksName} --region ${me.data.region} --alias hyperpod-eks`}
                          lang="bash"
                        />
                      </>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="text-sm text-fg-muted">
                    {t('connectSlurm')}
                  </div>
                  <CodeBlock code={`hyperpod-training/scripts/head-node.sh`} lang="bash" />
                  <div className="text-xs text-fg-muted">
                    {t('eksOrchestrator')}
                  </div>
                </div>
              )}
            </Card>
          </>
        )}

        {/* FSx for Lustre */}
        {fileSystems && fileSystems.length > 0 && (
          <Card title={t('fsx')}>
            <div className="space-y-4">
              {fileSystems.map((fs) => (
                <div key={fs.id} className="rounded border border-border bg-bg-elev-2 p-4">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="font-medium">{fs.label}</h4>
                      <div className="mt-1 flex items-center gap-3">
                        {fs.lifecycle && <Badge tone="info">{fs.lifecycle}</Badge>}
                        {fs.storageCapacityGiB && <span className="text-xs text-fg-muted">{fmtBytes(fs.storageCapacityGiB * 1024 ** 3)}</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => handleExportClick(fs.id)}>
                      {t('exportNow')}
                    </Button>
                  </div>

                  {fs.dnsName && (
                    <div className="mt-3 space-y-2 text-xs">
                      <div>
                        <div className="text-fg-muted">{t('dnsName')}</div>
                        <div className="flex items-center gap-2">
                          <code className="mono text-[11px] text-fg-faint">{fs.dnsName}</code>
                          <CopyButton text={fs.dnsName} />
                        </div>
                      </div>
                      {fs.mountName && (
                        <div>
                          <div className="text-fg-muted">{t('mountName')}</div>
                          <code className="mono text-[11px] text-fg-faint">{fs.mountName}</code>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Data Repository Associations */}
                  {fs.associations && fs.associations.length > 0 && (
                    <div className="mt-3">
                      <div className="mb-2 text-xs font-medium text-fg-muted">{t('repos')}</div>
                      <Table
                        head={[t('fsxPath'), t('s3Path'), tc('status')]}
                        dense
                      >
                        {fs.associations.map((a, i) => (
                          <tr key={i}>
                            <td className="mono text-[11px] text-fg-muted">{a.fileSystemPath ?? '—'}</td>
                            <td className="mono text-[11px] text-fg-muted">{a.dataRepositoryPath ?? '—'}</td>
                            <td>{a.lifecycle && <StatusPill status={a.lifecycle} />}</td>
                          </tr>
                        ))}
                      </Table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {!fileSystems || fileSystems.length === 0 && me.data?.features.fsx && (
          <EmptyState
            title={t('fsxNotConfigured')}
            hint={t('deployStack')}
          />
        )}
      </div>

      {scaleDialog && <ScaleControls {...scaleDialog} onClose={() => setScaleDialog(null)} onChanged={() => { void clustersResp.refetch(); }} />}

      {/* Export Dialog */}
      <Dialog
        open={!!exportDialog}
        onClose={() => setExportDialog(null)}
        title={t('exportPaths')}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportDialog(null)}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              loading={exportFsxMutation.isPending}
              onClick={handleExportApply}
            >
              {t('exportNow')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">{t('pathsLabel')}</label>
            <textarea
              value={exportPaths}
              onChange={(e) => setExportPaths(e.target.value)}
              className="w-full h-24 rounded border border-border bg-bg px-2 py-1 text-xs text-fg font-mono"
              placeholder="/fsx/checkpoints"
            />
          </div>
          <div className="text-xs text-fg-muted">
            {t('pathsHint')}
          </div>
        </div>
      </Dialog>

      {nodeRecoveryDialog && (
        <NodeActions
          cluster={nodeRecoveryDialog.cluster}
          instanceId={nodeRecoveryDialog.instanceId}
          action={nodeRecoveryDialog.action}
          onClose={() => setNodeRecoveryDialog(null)}
          onCompleted={() => { void clustersResp.refetch(); }}
        />
      )}


      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
