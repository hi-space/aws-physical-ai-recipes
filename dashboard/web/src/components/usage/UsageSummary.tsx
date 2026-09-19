'use client';
import { Badge, Card, ErrorBox, Spinner, Stat, Table } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { useT, useFormat, type Translator } from '@/lib/i18n';
import type { estimateRunUsage } from '@/server/services/usage';
type RunUsage = ReturnType<typeof estimateRunUsage>;

function translateTimingBasis(basis: string, t: Translator<'usage'>): string {
  const basisMap: Record<string, string> = {
    'runtime-receipts': t('timingBasisRuntimeReceipts'),
    'task-observation': t('timingBasisTaskObservation'),
    'not-started': t('timingBasisNotStarted'),
    'unknown': t('unknown'),
  };
  return basisMap[basis] || basis;
}

export const usageNumber = (value: number | null | undefined, unknownText: string, format?: (n: number) => string) => {
  if (value === null || value === undefined) return unknownText;
  return format ? format(value) : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
};
export function RunUsageView({ usage }: { usage: RunUsage }) {
  const t = useT('usage');
  const tc = useT('common');
  const { fmtNum } = useFormat();
  const unknownText = t('unknown');
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-2">
      <Stat label={t('cpuEstimate')} value={usageNumber(usage.cpuHours, unknownText, fmtNum)} sub={usage.cpuHours === null ? `${t('partial')} ${usageNumber(usage.knownCpuHours, unknownText, fmtNum)}` : t('cpuEstimateSub')} />
      <Stat label={t('gpuEstimate')} value={usageNumber(usage.gpuHours, unknownText, fmtNum)} sub={usage.gpuHours === null ? `${t('partial')} ${usageNumber(usage.knownGpuHours, unknownText, fmtNum)}` : t('gpuEstimateSub')} />
    </div>
    <Badge tone={usage.complete ? 'info' : 'warn'}>{usage.complete ? t('recordBasis') : t('partialRecord')}</Badge>
    <Table head={[tc('task'), t('attempts'), 'CPU-hours', 'GPU-hours', 'Platform']} dense>
      {usage.tasks.map(task => <tr key={task.name}>
        <td>{task.name}</td><td>{task.attemptsObserved} / {task.attemptsExpected}<br />{translateTimingBasis(task.timingBasis, t)}</td>
        <td>{usageNumber(task.cpuHours, unknownText, fmtNum)}</td><td>{usageNumber(task.gpuHours, unknownText, fmtNum)}</td>
        <td>{task.platform ?? t('platformNotSpecified')}</td>
      </tr>)}
    </Table>
    {!!usage.issues.length && <ul aria-label={t('usageEstimationLimits')} className="space-y-1 text-sm text-fg-muted">{usage.issues.map((issue, index) => <li key={`${issue.task}:${issue.code}:${index}`}>{issue.task ? `${issue.task}: ` : ''}{t(`issue_${issue.code}` as any)}</li>)}</ul>}
  </div>;
}
export function RunUsagePanel({ workflowId }: { workflowId: string }) {
  const t = useT('usage');
  const query = useApi<RunUsage>(`/api/workflows/${encodeURIComponent(workflowId)}/usage`, { refetch: 30000 });
  return <Card title={t('runUsageTitle')} description={t('runUsageDesc')}>
    <ErrorBox error={query.error} />
    {query.isLoading && <Spinner label={t('runTimeLoading')} />}
    {query.data && <RunUsageView usage={query.data} />}
  </Card>;
}
