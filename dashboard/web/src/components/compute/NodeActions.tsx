'use client';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorBox, KeyValue, Spinner, Table } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n';
import type { NodeRecoveryPlan, NodeRecoveryResult } from '@/server/services/node-recovery';

/**
 * Plan → acknowledge → apply for HyperPod node reboot/replace through SageMaker BatchReboot/ReplaceClusterNodes.
 * The plan is a live read of DescribeClusterNode plus (EKS) the Kubernetes node and its pods; the server re-reads all
 * of it on execute and refuses when anything changed.
 */
export function NodeActions({ cluster, instanceId, action, onClose, onCompleted }: {
  cluster: string; instanceId: string; action: 'reboot' | 'replace'; onClose: () => void; onCompleted: () => void;
}) {
  const t = useT('compute');
  const tc = useT('common');
  const { fmtTime } = useFormat();
  const base = `/api/clusters/${encodeURIComponent(cluster)}/nodes/${encodeURIComponent(instanceId)}/recovery`;
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<NodeRecoveryResult>();
  const plan = useApi<{ plan: NodeRecoveryPlan }>(`${base}?action=${action}`, { refetch: 0 });
  const data = plan.data?.plan;
  const needsAck = data?.warnings.some((w) => w.code === 'running_pods') ?? false;
  const canExecute = Boolean(data) && !plan.isFetching && !busy && data!.blockers.length === 0 && (!needsAck || acknowledged);

  async function execute() {
    if (!data || !canExecute) return;
    setBusy(true); setError(undefined);
    try {
      setResult(await api<NodeRecoveryResult>(base, { method: 'POST', json: { action, token: data.token, acknowledgeRunningPods: acknowledged } }));
      onCompleted();
    } catch (e) {
      setError(e);
      if ((e as { code?: string }).code === 'node_state_changed') void plan.refetch();
    } finally {
      setBusy(false);
    }
  }
  const explain = (item: { code: string; params?: Record<string, string> }) => {
    const p = item.params ?? {};
    switch (item.code) {
      case 'instance_not_running': return t('blocker_instance_not_running', { status: p.status ?? tc('unknown') });
      case 'cluster_not_in_service': return t('blocker_cluster_not_in_service', { status: p.status ?? tc('unknown') });
      case 'not_in_cluster': return t('blocker_not_in_cluster', { instanceId: p.instanceId ?? instanceId, cluster: p.cluster ?? cluster, error: p.error ?? '' });
      case 'running_pods': return t('warning_running_pods', { count: p.count ?? '', pods: p.pods ?? '' });
      case 'k8s_node_missing': return t('warning_k8s_node_missing');
      default: return item.code;
    }
  };
  const actionLabel = action === 'reboot' ? t('nodeReboot') : t('nodeReplace');

  return (
    <Dialog open onClose={onClose} title={`${t('nodeRecovery')} · ${actionLabel} · ${instanceId}`} width="lg">
      <div className="space-y-4">
        <ErrorBox error={plan.error} />
        <ErrorBox error={error} />
        {plan.isLoading && <Spinner label={tc('loading')} />}
        {data && !result && (
          <>
            <KeyValue items={[
              { k: t('planInstanceId'), v: <span className="mono text-xs">{data.node.instanceId}</span> },
              { k: t('planGroup'), v: data.node.group ? `${data.node.group} · ${data.node.instanceType ?? ''}` : tc('unknown') },
              { k: t('planInstanceStatus'), v: data.node.instanceStatus ? <Badge tone={data.node.instanceStatus === 'Running' ? 'ok' : 'warn'}>{data.node.instanceStatus}</Badge> : tc('unknown') },
              ...(data.node.k8sName ? [
                { k: t('planNode'), v: <span className="mono text-xs">{data.node.k8sName}</span> },
                { k: t('planHealth'), v: data.node.health ? <Badge tone={data.node.health === 'Schedulable' ? 'ok' : 'warn'}>{data.node.health}</Badge> : tc('unknown') },
                { k: t('planGpu'), v: String(data.node.gpuCapacity ?? 0) },
              ] : []),
              { k: t('planCluster'), v: <span>{data.cluster.name} · {data.cluster.orchestrator === 'eks' ? t('eks') : t('slurm')} {data.cluster.status && <StatusInline value={data.cluster.status} />}</span> },
              { k: t('planNodeRecovery'), v: data.cluster.nodeRecovery ?? tc('unknown') },
            ]} />
            <p className="text-xs text-fg-faint">{t('planObserved', { time: fmtTime(data.observedAt) })}</p>
            {data.cluster.orchestrator === 'eks' && (
              <Card title={t('planPods')} padded={false}>
                {data.pods.length === 0 ? <p className="p-3 text-sm text-fg-muted">{tc('none')}</p> : (
                  <Table head={[tc('namespace'), tc('name'), t('planPhase'), t('planOwner'), tc('workflow')]} dense>
                    {data.pods.map((p) => (
                      <tr key={`${p.namespace}/${p.name}`}>
                        <td className="text-xs">{p.namespace}</td>
                        <td className="mono text-[11px]">{p.name}</td>
                        <td className="text-xs">{p.phase ?? '—'}</td>
                        <td className="text-xs">{p.owner ?? '—'}</td>
                        <td className="mono text-[11px]">{p.workflowId ?? '—'}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}
            {data.blockers.length > 0 && (
              <Card title={t('planBlockers')}>
                <ul className="space-y-1 text-sm text-err" aria-label={t('planBlockers')}>{data.blockers.map((b) => <li key={b.code}><code className="text-xs">{b.code}</code> · {explain(b)}</li>)}</ul>
              </Card>
            )}
            {data.warnings.length > 0 && (
              <Card title={t('planWarnings')}>
                <ul className="space-y-1 text-sm text-warn" aria-label={t('planWarnings')}>{data.warnings.map((w) => <li key={w.code}><code className="text-xs">{w.code}</code> · {explain(w)}</li>)}</ul>
                {needsAck && (
                  <label className="mt-3 flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={busy} />
                    <span>{t('planAckRunningPods')}</span>
                  </label>
                )}
              </Card>
            )}
            <p className="text-xs text-fg-muted">{action === 'reboot' ? t('planEffectReboot', { api: data.api }) : t('planEffectReplace', { api: data.api })}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy || plan.isFetching} onClick={() => { setError(undefined); void plan.refetch(); }}>{t('planRefresh')}</Button>
              <Button variant="primary" disabled={!canExecute} loading={busy} onClick={() => void execute()}>{t('planExecute', { action: actionLabel })}</Button>
              <Button variant="ghost" disabled={busy} onClick={onClose}>{tc('close')}</Button>
            </div>
          </>
        )}
        {result && (
          <Card title={t('nodeRecovery')}>
            <p className="text-sm">{result.successful.length ? <Badge tone="ok">{t('planAccepted', { api: result.api })}</Badge> : <Badge tone="err">{t('planRejected', { api: result.api })}</Badge>}</p>
            {result.failed.map((f, i) => <ErrorBox key={i} error={{ message: `${f.nodeId ?? ''} ${f.code ?? ''}: ${f.message ?? ''}` }} className="mt-2" />)}
            <p className="mt-2 text-sm text-fg-muted">{t('planSuccess', { time: fmtTime(result.appliedAt) })}</p>
            <Button className="mt-3" variant="primary" onClick={onClose}>{tc('close')}</Button>
          </Card>
        )}
      </div>
    </Dialog>
  );
}
function StatusInline({ value }: { value: string }) { return <Badge tone={value === 'InService' ? 'ok' : 'warn'}>{value}</Badge>; }
