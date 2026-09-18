'use client';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorBox, KeyValue, Spinner, Table } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n';
import type { NodeRecoveryPlan, NodeRecoveryResult } from '@/server/services/node-recovery';

const LABEL = { reboot: 'UnschedulablePendingReboot', replace: 'UnschedulablePendingReplacement' } as const;

/**
 * Plan → acknowledge → apply for HyperPod node reboot/replace. The plan is a live read of the node, the cluster's
 * NodeRecovery setting and the pods on the node; the server re-reads all of it and refuses when anything changed.
 */
export function NodeActions({ cluster, node, action, onClose, onCompleted }: {
  cluster: string; node: string; action: 'reboot' | 'replace'; onClose: () => void; onCompleted: () => void;
}) {
  const t = useT('compute');
  const tc = useT('common');
  const { fmtTime } = useFormat();
  const base = `/api/clusters/${encodeURIComponent(cluster)}/nodes/${encodeURIComponent(node)}/recovery`;
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [success, setSuccess] = useState<NodeRecoveryResult>();
  const plan = useApi<{ plan: NodeRecoveryPlan }>(`${base}?action=${action}`, { refetch: 0 });
  const data = plan.data?.plan;
  const needsAck = data?.warnings.some((w) => w.code === 'running_pods') ?? false;
  const canExecute = Boolean(data) && !plan.isFetching && !busy && data!.blockers.length === 0 && (!needsAck || acknowledged);

  async function execute() {
    if (!data || !canExecute) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api<NodeRecoveryResult>(base, { method: 'POST', json: { action, token: data.token, acknowledgeRunningPods: acknowledged } });
      setSuccess(result);
      onCompleted();
    } catch (e) {
      setError(e);
      if ((e as { code?: string }).code === 'node_state_changed') void plan.refetch();
    } finally {
      setBusy(false);
    }
  }
  const explain = (item: { code: string; params?: Record<string, string> }) => {
    switch (item.code) {
      case 'node_recovery_disabled': return t('blocker_node_recovery_disabled', { current: item.params?.current ?? tc('unknown') });
      case 'not_hyperpod_node': return t('blocker_not_hyperpod_node');
      case 'already_pending': return t('blocker_already_pending', { label: item.params?.label ?? '' });
      case 'cluster_mismatch': return t('blocker_cluster_mismatch', { node: item.params?.node ?? '', cluster: item.params?.cluster ?? '' });
      case 'running_pods': return t('warning_running_pods', { count: item.params?.count ?? '', pods: item.params?.pods ?? '' });
      default: return item.code;
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${t('nodeRecovery')} · ${action === 'reboot' ? t('nodeReboot') : t('nodeReplace')} · ${node}`} width="lg">
      <div className="space-y-4">
        <ErrorBox error={plan.error} />
        <ErrorBox error={error} />
        {plan.isLoading && <Spinner label={tc('loading')} />}
        {data && !success && (
          <>
            <KeyValue items={[
              { k: t('planNode'), v: <span className="mono text-xs">{data.node.name}</span> },
              { k: t('planInstanceId'), v: data.node.instanceId ? <span className="mono text-xs">{data.node.instanceId}</span> : tc('unknown') },
              { k: t('planGroup'), v: data.node.group ?? tc('unknown') },
              { k: t('planHealth'), v: data.node.health ? <Badge tone={data.node.health === 'Schedulable' ? 'ok' : 'warn'}>{data.node.health}</Badge> : tc('unknown') },
              { k: t('planGpu'), v: String(data.node.gpuCapacity) },
              { k: t('planNodeRecovery'), v: <Badge tone={data.cluster.nodeRecovery === 'Automatic' ? 'ok' : 'err'}>{data.cluster.nodeRecovery ?? tc('unknown')}</Badge> },
            ]} />
            <p className="text-xs text-fg-faint">{t('planObserved', { time: fmtTime(data.observedAt) })}</p>
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
            <p className="text-xs text-fg-muted">{t('planEffect', { label: LABEL[action] })}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy || plan.isFetching} onClick={() => { setError(undefined); void plan.refetch(); }}>{t('planRefresh')}</Button>
              <Button variant="primary" disabled={!canExecute} loading={busy} onClick={() => void execute()}>{t('planExecute')}</Button>
              <Button variant="ghost" disabled={busy} onClick={onClose}>{tc('close')}</Button>
            </div>
          </>
        )}
        {success && (
          <Card title={t('nodeRecovery')}>
            <p className="text-sm"><Badge tone="ok">{success.label}</Badge></p>
            <p className="mt-2 text-sm text-fg-muted">{t('planSuccess', { label: success.label, time: fmtTime(success.appliedAt) })}</p>
            <Button className="mt-3" variant="primary" onClick={onClose}>{tc('close')}</Button>
          </Card>
        )}
      </div>
    </Dialog>
  );
}
