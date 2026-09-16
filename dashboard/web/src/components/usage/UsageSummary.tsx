'use client';
import { Badge, Card, ErrorBox, Spinner, Stat, Table } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import type { estimateRunUsage } from '@/server/services/usage';
type RunUsage = ReturnType<typeof estimateRunUsage>;
export const usageNumber = (value: number | null | undefined) => value === null || value === undefined ? '알 수 없음' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
export const usageUsd = (value: number | null | undefined) => value === null || value === undefined ? '알 수 없음' : `$${value.toFixed(4)}`;
export function PricingBasis({ pricing }: { pricing: RunUsage['pricing'] }) {
  return <div className="space-y-1 text-xs text-fg-muted">
    <p>USD · HyperPod On-Demand · {pricing.region} · 조회 {pricing.retrievedAt} · 가격표 게시 {pricing.publicationDate}</p>
    {!pricing.fresh && <p className="text-warn">단가가 오래되었거나 조회 시각이 유효하지 않아 금액을 확정하지 않습니다.</p>}
    {pricing.sourceUrl.startsWith('https://pricing.us-east-1.amazonaws.com/') && <a className="underline" href={pricing.sourceUrl} target="_blank" rel="noreferrer">공식 AWS 가격표 원문</a>}
    <p>과거 실행도 위 조회 시점의 단가로 재산정합니다. AWS 청구액·할인·세금과 구분하세요.</p>
  </div>;
}
export function RunUsageView({ usage }: { usage: RunUsage }) {
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-3">
      <Stat label="요청 CPU-hours 추정" value={usageNumber(usage.cpuHours)} sub={usage.cpuHours === null ? `확인된 부분 ${usageNumber(usage.knownCpuHours)}` : '요청 CPU × replica 실행시간'} />
      <Stat label="요청 GPU-hours 추정" value={usageNumber(usage.gpuHours)} sub={usage.gpuHours === null ? `확인된 부분 ${usageNumber(usage.knownGpuHours)}` : '요청 GPU × replica 실행시간'} />
      <Stat label="요청 자원 비례 예상 금액" value={usageUsd(usage.estimatedUsd)} sub={usage.estimatedUsd === null ? `가격을 확인한 부분 ${usageUsd(usage.knownEstimatedUsd)}` : '실제 노드 청구액이 아닙니다.'} />
    </div>
    <Badge tone={usage.complete ? 'info' : 'warn'}>{usage.complete ? '조회 기록 기준 추정' : '일부 기록·단가 확인 필요'}</Badge>
    <Table head={['작업', '관측 attempt / 시간 근거', 'CPU-hours', 'GPU-hours', '자원 비례 금액', '플랫폼 / 노드 시간단가']} dense>
      {usage.tasks.map(task => <tr key={task.name}>
        <td>{task.name}</td><td>{task.attemptsObserved} / {task.attemptsExpected}<br />{{ 'runtime-receipts': 'runtime 기록', 'task-observation': '상태 관측 (보조)', 'not-started': '시작 전', unknown: '알 수 없음' }[task.timingBasis]}</td>
        <td>{usageNumber(task.cpuHours)}</td><td>{usageNumber(task.gpuHours)}</td><td>{usageUsd(task.estimatedUsd)}</td>
        <td>{task.platform ?? '플랫폼 미지정'}<br />{task.rate ? `${usageUsd(task.rate.usdPerHour)}/h · ${task.rate.sku}` : '확인된 단가 없음'}</td>
      </tr>)}
    </Table>
    {!!usage.issues.length && <ul aria-label="사용량 추정 한계" className="space-y-1 text-sm text-fg-muted">{usage.issues.map((issue, index) => <li key={`${issue.task}:${issue.code}:${index}`}>{issue.task ? `${issue.task}: ` : ''}{issue.message}</li>)}</ul>}
    <details><summary className="cursor-pointer text-sm">추정 산식·근거·제외 항목</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm">{usage.formula}</p>
        <p className="text-sm">replica별 전용 노드 가정: {usageUsd(usage.dedicatedInstanceUsd)}. 노드를 공유하면 중복되는 가정입니다.</p>
        <PricingBasis pricing={usage.pricing} />
        <ul className="space-y-1 text-xs text-fg-muted">{usage.exclusions.map(item => <li key={item}>{item}</li>)}</ul>
      </div>
    </details>
  </div>;
}
export function RunUsagePanel({ workflowId }: { workflowId: string }) {
  const query = useApi<RunUsage>(`/api/workflows/${encodeURIComponent(workflowId)}/usage`, { refetch: 30000 });
  return <Card title="실행 사용량·예상 비용" description="실제 이용률이나 AWS 청구액이 아닌, 요청 자원과 확인된 실행 기록의 추정치입니다.">
    <ErrorBox error={query.error} />
    {query.isLoading && <Spinner label="실행 시간과 단가를 확인하는 중…" />}
    {query.data && <RunUsageView usage={query.data} />}
  </Card>;
}
