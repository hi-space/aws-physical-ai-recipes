'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Select, Spinner, Stat, Table } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { PricingBasis, usageNumber, usageUsd } from '@/components/usage/UsageSummary';
import type { projectUsage } from '@/server/services/usage';
type ProjectUsage = Awaited<ReturnType<typeof projectUsage>>;
export function UsagePage() {
  const me = useMe(), projects = useApi<Array<{ id: string; name: string }>>('/api/projects');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('projectId');
    if (id) setSelected(id);
  }, []);
  const projectId = selected ?? me.data?.project?.id ?? projects.data?.[0]?.id;
  const query = useApi<ProjectUsage>(projectId ? `/api/usage?projectId=${encodeURIComponent(projectId)}` : null, { refetch: 30000 });
  async function refreshRates() {
    setBusy(true); setError(undefined);
    try { await api('/api/usage/rates', { method: 'POST' }); await query.refetch(); }
    catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader title="사용량·예상 비용" description="프로젝트와 실행의 요청 CPU/GPU-hours를 확인합니다. 계정 전체 청구액은 연구 현황의 관리자 전용 비용 항목과 구분합니다." />
    <ErrorBox error={me.error} /><ErrorBox error={projects.error} /><ErrorBox error={query.error} /><ErrorBox error={error} />
    <div className="flex flex-wrap items-end gap-3">
      <Field label="비용 추정 프로젝트"><Select value={projectId ?? ''} onChange={event => setSelected(event.target.value)}>
        <option value="" disabled>프로젝트 선택</option>{projects.data?.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
      </Select></Field>
      <Button disabled={query.isFetching || !projectId} onClick={() => void query.refetch()}>사용량 다시 조회</Button>
      {me.data?.role === 'admin' && <Button disabled={busy} loading={busy} onClick={() => void refreshRates()}>공식 단가 새로 조회</Button>}
    </div>
    {(query.isLoading || projects.isLoading) && <Spinner label="사용량 근거를 읽는 중…" />}
    {!projects.isLoading && !projects.error && !projects.data?.length && <EmptyState title="참여한 프로젝트가 없습니다." />}
    {query.data && <Card title={`${query.data.project.name} · 조회된 실행 ${query.data.runs.length}개`}>
      {!query.data.runs.length ? <EmptyState title="추정할 실행 기록이 없습니다." hint="이는 프로젝트의 실제 청구액이 0이라는 뜻이 아닙니다." /> : <>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Stat label="요청 CPU-hours 추정" value={usageNumber(query.data.cpuHours)} />
          <Stat label="요청 GPU-hours 추정" value={usageNumber(query.data.gpuHours)} />
          <Stat label="요청 자원 비례 예상 금액" value={usageUsd(query.data.estimatedUsd)} />
        </div>
        <p className="mb-3 text-xs text-fg-muted">{query.data.discoveryBasis}</p>
        {!query.data.complete && <p className="mb-3 text-sm text-warn">누락된 시간·단가 또는 조회 한도가 있어 전체 합계는 확정하지 않습니다. 각 실행의 근거를 확인하세요.</p>}
        <Table head={['실행', 'backend', 'CPU-hours', 'GPU-hours', '예상 금액', '근거 상태']} dense>
          {query.data.runs.map(run => <tr key={run.workflowId}>
            <td><Link href={`/workflows/${encodeURIComponent(run.workflowId)}`} className="underline">{run.name ?? run.workflowId}</Link></td>
            <td>{run.backendId}</td><td>{usageNumber(run.cpuHours)}</td><td>{usageNumber(run.gpuHours)}</td><td>{usageUsd(run.estimatedUsd)}</td>
            <td><Badge tone={run.complete ? 'info' : 'warn'}>{run.complete ? '기록 기준 추정' : '일부 알 수 없음'}</Badge></td>
          </tr>)}
        </Table>
      </>}
      <div className="mt-4"><PricingBasis pricing={query.data.pricing} /></div>
      <p className="mt-3 text-xs text-fg-muted">요청 자원의 CPU 또는 GPU 점유 비율 중 큰 값으로 노드 단가를 배분합니다. 유휴 노드·준비/종료·스토리지·네트워크 비용은 포함하지 않으며 예약·Spot 단가를 대신 추측하지 않습니다.</p>
    </Card>}
  </div>;
}
