'use client';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Bar, Card, EmptyState, ErrorBox, LinkButton, Spinner, Stat, StatusPill, Table } from '@/components/ui';
import { Sparkline } from '@/components/charts/Sparkline';
import { ago, fmtNum, fmtUsd } from '@/lib/format';
import { useApi, useMe, can } from '@/lib/api-client';
import type { overview } from '@/server/services/overview';

// Type-only import: track the service DTO without bundling server code into the browser.
type OverviewData = Awaited<ReturnType<typeof overview>>;
const ACCOUNT_COST_LABEL = 'AWS 계정 전체 비용 (최근 30일)';

export function OverviewPage() {
  const me = useMe();
  const { data, isLoading, error } = useApi<OverviewData>('/api/overview', { refetch: 15000 });

  if (isLoading && !data) return <><PageHeader title="연구 개요" /><Spinner label="개요를 불러오는 중…" /></>;
  if (!data) return <><PageHeader title="연구 개요" /><ErrorBox error={error ?? new Error('개요 데이터를 받지 못했습니다.')} /></>;

  const cost = can(me.data, 'admin') ? data.cost : undefined;
  const costDaily = (cost?.daily ?? []).map((day) => day.amount).filter(Number.isFinite);
  const costMax = Math.max(...(cost?.byService ?? []).map((service) => service.amount), 1);
  const serviceErrors = [...new Set([...data.errors, data.nodes.error].filter((message): message is string => Boolean(message)))];
  const nodeError = Boolean(data.nodes.error);
  const gpuAverage = !nodeError && data.nodes.gpuCapacity > 0 && Number.isFinite(data.nodes.gpuUtilAvg)
    ? `평균 사용률 ${fmtNum(data.nodes.gpuUtilAvg)}%` : '평균 사용률 N/A';
  const status = data.workflows.byStatus;

  return (
    <>
      <PageHeader title="연구 개요" description="연구 실행, 데이터 준비, 가용 자원을 확인합니다." />
      <div className="space-y-4">
        {error && <div role="alert" className="space-y-2"><p className="text-sm text-fg-muted">최신 조회에 실패해 이전 결과를 표시합니다.</p><ErrorBox error={error} /></div>}
        {me.error && <ErrorBox error={me.error} />}
        {serviceErrors.length > 0 && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-fg-muted">일부 데이터를 불러오지 못했습니다. 아래 오류를 확인하세요.</p>
            {serviceErrors.map((message) => <ErrorBox key={message} error={{ message }} />)}
          </div>
        )}

        <Card title="연구 시작" description="데이터 준비 → 레시피 실행 → 결과 비교">
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/datasets">데이터셋 관리</LinkButton>
            {can(me.data, 'researcher') && <LinkButton href="/workflows/new" variant="primary">레시피 선택·실행</LinkButton>}
            {data.features.pipeline && can(me.data, 'researcher') && <LinkButton href="/pipelines">GR00T 파이프라인</LinkButton>}
            {data.features.mlflow && <LinkButton href="/experiments">실험 비교</LinkButton>}
            {data.features.dcv && <LinkButton href="/sessions">시뮬레이션·세션</LinkButton>}
            {data.features.eks && <LinkButton href="/compute">컴퓨트 현황</LinkButton>}
            {data.features.amp && <LinkButton href="/metrics">자원 지표</LinkButton>}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="워크플로"
            value={fmtNum(data.workflows.total)}
            sub={`실행 중 ${fmtNum(status.RUNNING ?? 0)} · 대기 ${fmtNum(status.PENDING ?? 0)} · 결과 저장 중 ${fmtNum(status.FINALIZING ?? 0)} · 취소 중 ${fmtNum(status.CANCELLING ?? 0)}`}
          />
          {data.features.eks && (
            <>
              <Stat
                label="할당 가능한 GPU"
                value={nodeError ? '—' : fmtNum(data.nodes.gpuAllocatable)}
                sub={nodeError ? '노드 조회 실패' : `전체 ${fmtNum(data.nodes.gpuCapacity)}개 · ${gpuAverage}`}
                tone={nodeError ? 'err' : data.nodes.gpuAllocatable > 0 ? 'ok' : 'warn'}
              />
              <Stat
                label="준비된 Kubernetes 노드"
                value={nodeError ? '—' : `${data.nodes.ready}/${data.nodes.total}`}
                tone={nodeError ? 'err' : data.nodes.total > 0 && data.nodes.ready === data.nodes.total ? 'ok' : 'warn'}
              />
              <Stat
                label="Kueue 대기 작업"
                value={fmtNum(data.queues.pendingWorkloads)}
                sub={`승인된 작업 ${fmtNum(data.queues.admitted)}개`}
                tone={data.queues.pendingWorkloads > 0 ? 'warn' : 'ok'}
              />
            </>
          )}
          {cost && <Stat label={ACCOUNT_COST_LABEL} value={fmtUsd(cost.total)} sub="이 대시보드 외의 AWS 서비스 비용도 포함합니다." />}
        </div>

        <Card title="최근 워크플로" description={`조회된 실행 ${fmtNum(data.workflows.total)}개`} actions={<LinkButton href="/workflows" size="sm">실행 목록</LinkButton>}>
          {!data.workflows.recent.length ? (
            <EmptyState title="표시할 워크플로가 없습니다." hint={serviceErrors.length ? '위 조회 오류를 확인하세요.' : '레시피를 선택해 첫 실행을 시작하세요.'} />
          ) : (
            <Table head={['이름', '상태', '사용자', '완료 작업', '생성 시각']} dense>
              {data.workflows.recent.map((workflow) => (
                <tr key={workflow.id}>
                  <td><Link href={`/workflows/${encodeURIComponent(workflow.id)}`} className="text-accent hover:underline">{workflow.name}</Link></td>
                  <td><StatusPill status={workflow.status} /></td>
                  <td className="text-fg-muted">{workflow.owner || '—'}</td>
                  <td className="num">{`${fmtNum(workflow.succeededCount)}/${fmtNum(workflow.taskCount)}`}</td>
                  <td className="text-fg-muted">{ago(workflow.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="클러스터" description={`${data.clusters.length}개`}>
          {!data.clusters.length ? <EmptyState title="표시할 클러스터가 없습니다." /> : (
            <div className="space-y-2">
              {data.clusters.map((cluster) => (
                <div key={cluster.name} className="space-y-2 rounded border border-border bg-bg-elev-2 p-3">
                  <Link href="/compute" className="font-medium text-accent hover:underline">{cluster.name}</Link>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{cluster.orchestrator}</Badge>
                    {cluster.status && !cluster.status.startsWith('error:') && <StatusPill status={cluster.status} />}
                    {cluster.groups.map((group) => (
                      <span key={group.name} className="text-xs text-fg-muted">
                        <Badge tone={group.isGpu ? 'accent' : 'neutral'}>{group.name}</Badge> 현재 {group.current} / 목표 {group.target}
                      </span>
                    ))}
                  </div>
                  {cluster.status?.startsWith('error:') && <ErrorBox error={{ message: cluster.status }} />}
                  {'failureMessage' in cluster && cluster.failureMessage && <ErrorBox error={{ message: cluster.failureMessage }} />}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="최근 이벤트" description="최대 15개">
          {!data.recentEvents.length ? <EmptyState title="최근 이벤트가 없습니다." /> : (
            <div className="space-y-2">
              {data.recentEvents.map((event, index) => (
                <div key={`${event.ts}-${index}`} className="flex items-start gap-3 border-l-2 border-border px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-fg">{event.workflowName} <span className="text-fg-muted">· {event.reason}</span></div>
                    <div className="mt-1 text-fg-muted">{event.message}</div>
                  </div>
                  <div className="text-fg-faint">{ago(event.ts)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {cost && (
          <Card title={ACCOUNT_COST_LABEL} description="서비스별 계정 비용입니다. 프로젝트별 비용과 구분해 확인하세요.">
            {costDaily.length > 0 && <div className="mb-4" aria-label="AWS 계정 일별 비용 추이"><Sparkline values={costDaily} width={240} height={36} /></div>}
            {!cost.byService.length ? <EmptyState title="조회된 서비스별 비용이 없습니다." /> : (
              <div className="space-y-3">
                {cost.byService.slice(0, 10).map((service) => (
                  <div key={service.service}>
                    <div className="mb-1 flex justify-between text-xs"><span className="text-fg-muted">{service.service}</span><span className="num">{fmtUsd(service.amount)}</span></div>
                    <Bar value={service.amount} max={costMax} tone="accent" />
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {data.controller && (
          <Card title="실행 제어 서비스 상태" className="border-l-2 border-l-info">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <Badge tone={data.controller.running ? 'ok' : 'err'}>{data.controller.running ? '동작 중' : '응답 확인 필요'}</Badge>
              {data.controller.lastTick && <span className="text-fg-muted">최근 상태 확인: {ago(data.controller.lastTick)}</span>}
              {data.controller.leased && <Badge tone="accent">실행 담당 서비스 연결됨</Badge>}
            </div>
            {data.controller.lastError && <ErrorBox error={{ message: data.controller.lastError }} className="mt-2" />}
          </Card>
        )}
      </div>
    </>
  );
}
