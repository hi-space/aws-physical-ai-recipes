'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Tabs, Toast } from '@/components/ui';
import { ago, classNames as cx, fmtBytes, fmtTime, shortId } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';

interface ClusterSummary {
  name: string;
  orchestrator: 'eks' | 'slurm';
  status?: string;
  arn?: string;
  createdAt?: string;
  failureMessage?: string;
  groups: { name: string; instanceType: string; current: number; target: number; status?: string; isGpu: boolean; isSystem: boolean }[];
  nodes: { id: string; group: string; instanceType: string; status: string; launchTime?: string }[];
  events?: { EventId?: string; EventTime?: string; ResourceType?: string; Description?: string }[];
}

interface ClusterResponse {
  clusters: ClusterSummary[];
  k8sNodes: { name: string; instanceType?: string; group?: string; health?: string; ready: boolean; gpuCapacity: number; gpuAllocatable: number; cpu?: string; memory?: string; kubelet?: string; taints: string[]; unschedulable: boolean }[];
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
  const me = useMe();
  const [activeTab, setActiveTab] = React.useState<'eks' | 'slurm'>('eks');
  const [scaleDialog, setScaleDialog] = React.useState<{ cluster: string; group: string; current: number } | null>(null);
  const [scaleValue, setScaleValue] = React.useState<string>('');
  const [exportDialog, setExportDialog] = React.useState<{ fileSystemId: string } | null>(null);
  const [exportPaths, setExportPaths] = React.useState<string>('/fsx/checkpoints');
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const clustersResp = useApi<ClusterResponse>('/api/clusters', { refetch: 10000 });
  const fsxResp = useApi<FileSystem[]>('/api/fsx', { refetch: 10000 });

  const scaleClusterMutation = useApiMutation(
    async (params: { cluster: string; group: string; count: number; expectedCount: number }) => {
      const res = await fetch(`/api/clusters/${params.cluster}/scale`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: params.group, count: params.count, expectedCount: params.expectedCount }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? `Scale failed: ${res.statusText}`);
      return result;
    },
    ['/api/clusters'],
  );

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
    setScaleValue(String(current));
  };

  const handleScaleApply = async () => {
    if (!scaleDialog) return;
    const count = parseInt(scaleValue, 10);
    if (isNaN(count) || count < 0) {
      setToast({ message: 'Invalid node count', tone: 'err' });
      return;
    }
    try {
      await scaleClusterMutation.mutateAsync({ cluster: scaleDialog.cluster, group: scaleDialog.group, count, expectedCount: scaleDialog.current });
      setToast({ message: `Scaling ${scaleDialog.group} to ${count} nodes`, tone: 'ok' });
      setScaleDialog(null);
    } catch (e) {
      setToast({ message: `Error: ${(e as Error).message}`, tone: 'err' });
    }
  };

  const handleExportClick = (fileSystemId: string) => {
    setExportDialog({ fileSystemId });
    setExportPaths('/fsx/checkpoints');
  };

  const handleExportApply = async () => {
    if (!exportDialog) return;
    const paths = exportPaths.split('\n').map((p) => p.trim()).filter(Boolean);
    if (!paths.length) {
      setToast({ message: 'Enter at least one path', tone: 'err' });
      return;
    }
    try {
      await exportFsxMutation.mutateAsync({ fileSystemId: exportDialog.fileSystemId, paths });
      setToast({ message: `Exporting ${paths.length} path(s)`, tone: 'ok' });
      setExportDialog(null);
    } catch (e) {
      setToast({ message: `Error: ${(e as Error).message}`, tone: 'err' });
    }
  };

  const clusters = clustersResp.data?.clusters ?? [];
  const k8sNodes = clustersResp.data?.k8sNodes ?? [];
  const addons = clustersResp.data?.addons ?? [];
  const fileSystems = fsxResp.data ?? [];

  const eksCluster = clusters.find((c) => c.orchestrator === 'eks');
  const slurmCluster = clusters.find((c) => c.orchestrator === 'slurm');

  const showTab = eksCluster || slurmCluster;
  const activeCluster = activeTab === 'eks' ? eksCluster : slurmCluster;

  return (
    <>
      <PageHeader title="Compute" description="Cluster resources, instance groups, and file systems" />
      <div className="space-y-4">
        {clustersResp.error && <ErrorBox error={clustersResp.error} />}

        {showTab && (
          <Tabs
            value={activeTab}
            onChange={setActiveTab}
            items={[
              ...(eksCluster ? [{ id: 'eks' as const, label: 'EKS', count: clusters.filter((c) => c.orchestrator === 'eks').length }] : []),
              ...(slurmCluster ? [{ id: 'slurm' as const, label: 'Slurm', count: clusters.filter((c) => c.orchestrator === 'slurm').length }] : []),
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
                  {activeCluster.failureMessage && <ErrorBox error={new Error(activeCluster.failureMessage)} className="mt-2" />}
                </div>
                <div className="flex-1">
                  <div className="text-xs text-fg-muted mb-1">Cluster ARN</div>
                  <div className="flex items-center gap-2">
                    <code className="mono text-[11px] text-fg-faint">{shortId(activeCluster.arn, 80)}</code>
                    {activeCluster.arn && <CopyButton text={activeCluster.arn} />}
                  </div>
                </div>
              </div>
              {activeCluster.createdAt && (
                <div className="mt-3 text-xs text-fg-muted">
                  Created: <span>{fmtTime(activeCluster.createdAt)}</span>
                </div>
              )}
            </Card>

            {/* Instance Groups */}
            <Card title="Instance Groups">
              {activeCluster.groups.length === 0 ? (
                <EmptyState title="No instance groups" />
              ) : (
                <Table
                  head={['Group', 'Instance Type', 'Current / Target', 'Status', can(me.data, 'admin') ? 'Scale' : '']}
                  dense
                >
                  {activeCluster.groups.map((g) => (
                    <tr key={g.name} className={g.isSystem ? 'opacity-60' : ''}>
                      <td className="font-medium">{g.name}</td>
                      <td>
                        {g.isGpu && <Badge tone="accent">GPU</Badge>} {g.instanceType}
                      </td>
                      <td>
                        <Bar value={g.current} max={g.target || 1} label={`${g.current} / ${g.target}`} />
                      </td>
                      <td>{g.status && <StatusPill status={g.status} />}</td>
                      <td>
                        {can(me.data, 'admin') && !g.isSystem ? (
                          <Button size="sm" variant="ghost" onClick={() => handleScaleClick(activeCluster.name, g.name, g.target)}>
                            Scale
                          </Button>
                        ) : g.isSystem ? (
                          <span className="text-[11px] text-fg-faint">System</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            {/* K8s Nodes */}
            {activeTab === 'eks' && (
              <Card title="Nodes (Kubernetes)">
                {k8sNodes.length === 0 ? (
                  <EmptyState title="No Kubernetes nodes" />
                ) : (
                  <Table
                    head={['Node', 'Group', 'Status', 'GPU', 'Health', 'Kubelet', 'Taints']}
                    dense
                  >
                    {k8sNodes.map((n) => (
                      <tr key={n.name}>
                        <td className="mono text-[11px]">{n.name}</td>
                        <td className="text-xs text-fg-muted">{n.group ?? '—'}</td>
                        <td>
                          <Badge tone={n.ready ? 'ok' : 'err'}>{n.ready ? 'Ready' : 'NotReady'}</Badge>
                        </td>
                        <td className="num">{n.gpuAllocatable}/{n.gpuCapacity}</td>
                        <td>
                          {n.health && (
                            <Badge tone={n.health === 'Schedulable' && !n.unschedulable ? 'ok' : 'err'}>
                              {n.unschedulable ? 'Cordoned' : n.health}
                            </Badge>
                          )}
                        </td>
                        <td className="text-xs text-fg-muted">{shortId(n.kubelet, 12)}</td>
                        <td className="text-xs text-fg-muted">{n.taints.length > 0 ? n.taints.join(', ') : '—'}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}

            {/* Cluster Events */}
            {activeCluster.events && activeCluster.events.length > 0 && (
              <Card title="Cluster Events" description={`Latest 25`}>
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
              <Card title="Add-ons">
                {addons.length === 0 ? (
                  <EmptyState title="No add-ons installed" />
                ) : (
                  <Table head={['Add-on', 'Version', 'Status', 'Health']} dense>
                    {addons.map((a) => (
                      <tr key={a.name}>
                        <td className="font-medium">{a.name}</td>
                        <td className="text-fg-muted">{a.version ?? '—'}</td>
                        <td>{a.status && <StatusPill status={a.status} />}</td>
                        <td className="num">{a.health > 0 ? <Badge tone="err">Issues: {a.health}</Badge> : <Badge tone="ok">Healthy</Badge>}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}

            {/* Connect Instructions */}
            <Card title="Connect">
              {activeTab === 'eks' ? (
                <div className="space-y-3">
                  <div>
                    <div className="mb-2 text-xs font-medium text-fg-muted">Update kubeconfig:</div>
                    <CodeBlock
                      code={`aws eks update-kubeconfig --name ${me.data?.clusters.eksName ?? 'hyperpod-eks'} --region ${me.data?.region ?? 'us-east-1'} --alias hyperpod-eks`}
                      lang="bash"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="text-sm text-fg-muted">
                    Connect to the Slurm head node using:
                  </div>
                  <CodeBlock code={`hyperpod-training/scripts/head-node.sh`} lang="bash" />
                  <div className="text-xs text-fg-muted">
                    Workflows are submitted through the EKS orchestrator. Slurm is managed and not directly scheduled.
                  </div>
                </div>
              )}
            </Card>
          </>
        )}

        {/* FSx for Lustre */}
        {fileSystems && fileSystems.length > 0 && (
          <Card title="FSx for Lustre">
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
                      Export Now
                    </Button>
                  </div>

                  {fs.dnsName && (
                    <div className="mt-3 space-y-2 text-xs">
                      <div>
                        <div className="text-fg-muted">DNS Name</div>
                        <div className="flex items-center gap-2">
                          <code className="mono text-[11px] text-fg-faint">{fs.dnsName}</code>
                          <CopyButton text={fs.dnsName} />
                        </div>
                      </div>
                      {fs.mountName && (
                        <div>
                          <div className="text-fg-muted">Mount Name</div>
                          <code className="mono text-[11px] text-fg-faint">{fs.mountName}</code>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Data Repository Associations */}
                  {fs.associations && fs.associations.length > 0 && (
                    <div className="mt-3">
                      <div className="mb-2 text-xs font-medium text-fg-muted">Data Repository Associations</div>
                      <Table
                        head={['FSx Path', 'S3 Path', 'Status']}
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
            title="FSx for Lustre not configured"
            hint="Deploy the infrastructure stack to enable FSx file systems"
          />
        )}
      </div>

      {/* Scale Dialog */}
      <Dialog
        open={!!scaleDialog}
        onClose={() => setScaleDialog(null)}
        title={`Scale ${scaleDialog?.group} on ${scaleDialog?.cluster}`}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setScaleDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={scaleClusterMutation.isPending}
              onClick={handleScaleApply}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-sm text-fg-muted">
            Scale <strong>{scaleDialog?.group}</strong> from <strong>{scaleDialog?.current}</strong> to{' '}
            <strong>
              <Input
                type="number"
                value={scaleValue}
                onChange={(e) => setScaleValue(e.target.value)}
                min="0"
                max="256"
                className="inline-block w-16"
              />
            </strong>{' '}
            node(s)?
          </div>
          <div className="rounded border border-border/50 bg-bg-elev-2 p-2 text-xs text-fg-muted">
            Note: Nodes take 10–20 minutes to join the cluster and are billed while running.
          </div>
        </div>
      </Dialog>

      {/* Export Dialog */}
      <Dialog
        open={!!exportDialog}
        onClose={() => setExportDialog(null)}
        title="Export FSx Paths"
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={exportFsxMutation.isPending}
              onClick={handleExportApply}
            >
              Export
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Paths (one per line)</label>
            <textarea
              value={exportPaths}
              onChange={(e) => setExportPaths(e.target.value)}
              className="w-full h-24 rounded border border-border bg-bg px-2 py-1 text-xs text-fg font-mono"
              placeholder="/fsx/checkpoints"
            />
          </div>
          <div className="text-xs text-fg-muted">
            Paths will be exported to S3 according to the data repository association configuration.
          </div>
        </div>
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
