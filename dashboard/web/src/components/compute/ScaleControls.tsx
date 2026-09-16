'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api-client';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Spinner } from '@/components/ui';
import type { ScalePlan, ScalingPolicy, planScale, scaleSnapshot } from '@/server/services/scaling-plans';
type Snapshot = Awaited<ReturnType<typeof scaleSnapshot>>;
type Review = Awaited<ReturnType<typeof planScale>>;
interface PolicyDraft { min: string; baseline: string; minutes: string; idle: boolean; version: number }
export function ScaleControls({ cluster, group, current, onClose, onChanged }: {
  cluster: string; group: string; current: number; onClose(): void; onChanged(): void;
}) {
  const base = `/api/clusters/${encodeURIComponent(cluster)}/scale`;
  const snapshot = useApi<Snapshot>(`${base}?group=${encodeURIComponent(group)}`, { refetch: 15000 });
  const [count, setCount] = useState(String(current));
  const [draft, setDraft] = useState<PolicyDraft>();
  const [review, setReview] = useState<Review>();
  const [operation, setOperation] = useState<ScalePlan>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  function loadPolicy(policy?: ScalingPolicy) {
    const observedCount = snapshot.data?.currentCount ?? current;
    setDraft({ min: String(policy?.minCount ?? observedCount), baseline: String(policy?.baselineCount ?? observedCount),
      minutes: String(policy?.idleMinutes ?? 30), idle: policy?.idleEnabled ?? false, version: policy?.version ?? 0 });
  }
  useEffect(() => { if (snapshot.data && !draft) loadPolicy(snapshot.data.policy); }, [snapshot.data, draft]);
  const data = snapshot.data;
  const planned = review?.status === 'PLANNED' ? review.plan : undefined;
  const reviewedCurrent = planned && data && planned.to === Number(count) && planned.specHash === data.specHash &&
    planned.policyVersion === (data.policy?.version ?? 0) && !data.structuralBlockers.length &&
    (planned.to >= planned.from || !data.blockers.length);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await work(); } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function savePolicy(event: React.FormEvent) {
    event.preventDefault(); if (!data || !draft || busy) return;
    await action(async () => {
      const numbers = [Number(draft.min), Number(draft.baseline), Number(draft.minutes)];
      if (numbers.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('보호 기준과 유휴 기간은 유효한 정수여야 합니다.');
      const saved = await api<ScalingPolicy>(`${base}/policy`, { method: 'PUT', json: {
        group, expectedVersion: draft.version, minCount: numbers[0], baselineCount: numbers[1], idleMinutes: numbers[2],
        idleEnabled: draft.idle, observedSpecHash: data.specHash,
      } });
      if (saved.group !== group || saved.version !== draft.version + 1) throw new Error('정책 저장 응답을 확인하지 못했습니다.');
      loadPolicy(saved); setReview(undefined); await snapshot.refetch();
    });
  }
  async function makePlan(mode: 'manual' | 'idle') {
    if (!data || busy) return;
    await action(async () => {
      setReview(undefined); setOperation(undefined);
      const desired = mode === 'idle' ? data.floor : Number(count);
      if (!Number.isSafeInteger(desired) || desired < 0) throw new Error('유효한 목표 노드 수를 입력하세요.');
      setCount(String(desired));
      const result = await api<Review>(`${base}/plan`, { method: 'POST', json: {
        group, count: desired, expectedCount: data.targetCount, observedSpecHash: data.specHash, mode,
      } });
      if (!['PLANNED', 'BLOCKED'].includes(result?.status)) throw new Error('계획 응답을 확인하지 못했습니다.');
      setReview(result);
    });
  }
  async function execute() {
    if (!planned || !reviewedCurrent || busy) return;
    await action(async () => {
      const result = await api<ScalePlan>(base, { method: 'POST', json: { planId: planned.id } });
      if (result?.id !== planned.id || !['BLOCKED', 'PREPARING', 'ACCEPTED', 'UNKNOWN', 'SUCCEEDED', 'PARTIAL', 'FAILED'].includes(result.status)) throw new Error('용량 요청 결과를 확인하지 못했습니다.');
      setOperation(result); setReview(undefined); await snapshot.refetch(); onChanged();
    });
  }
  async function observe() {
    const id = operation?.id ?? data?.activeOperationId; if (!id || busy) return;
    await action(async () => {
      const result = await api<ScalePlan>(`${base}/reconcile`, { method: 'POST', json: { operationId: id } });
      if (result?.id !== id) throw new Error('관측 결과가 현재 요청과 일치하지 않습니다.');
      setOperation(result); await snapshot.refetch(); onChanged();
    });
  }
  const statusLabels: Record<string, string> = { PLANNED: '검토할 계획', PREPARING: '노드 확인 중', ACCEPTED: '요청 응답 수신 · 완료 확인 필요',
    UNKNOWN: '결과 불명확 · 자동 재시도하지 않음', SUCCEEDED: '실제 노드 수 확인 완료', PARTIAL: '부분 결과 · 실패 노드는 유지', FAILED: '요청 실패', BLOCKED: '변경 차단' };
  return <Dialog open onClose={onClose} title={`${group} · 노드 수 변경`} width="lg">
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">{cluster} · {data?.backendId ?? 'backend 확인 중'}. 계획 작성은 용량을 변경하지 않습니다.</p>
      <ErrorBox error={snapshot.error} /><ErrorBox error={error} />
      {snapshot.isLoading && <Spinner label="설정과 실제 활동을 검사하는 중…" />}
      {data && <>
        <p className="text-sm">현재 {data.currentCount ?? '알 수 없음'} / 목표 {data.targetCount ?? '알 수 없음'} · 보호 기준 {data.policy ? data.floor : '미설정'}개</p>
        {!!data.policy?.protectedInstanceIds?.length && <p className="break-all text-xs text-fg-muted">보호한 기준 인스턴스: {data.policy.protectedInstanceIds.join(', ')}</p>}
        <p className="text-xs text-fg-muted">관측 {data.observedAt}</p>
        <Card title="축소 차단 사유">
          {data.blockers.length ? <ul className="space-y-2 text-sm" aria-label="축소 차단 사유">{data.blockers.map((blocker, i) => <li key={`${blocker.code}:${i}`}>
            <code className="text-xs">{blocker.code}</code> · {blocker.message}
            {blocker.resources?.length && <p className="mt-1 break-all text-xs text-fg-muted">{blocker.resources.join(', ')}</p>}
          </li>)}</ul> : <p className="text-sm">현재 관측에서 차단 사유가 없습니다. 실행 직전에 다시 검사합니다.</p>}
        </Card>
        <details>
          <summary className="cursor-pointer text-sm">보호 기준·유휴 정책 설정</summary>
          {draft && <form onSubmit={savePolicy} className="mt-3 space-y-3">
            <p className="text-xs text-fg-muted">최소 유지 수와 보호 기준 중 큰 값을 유지합니다. 새 정책은 현재 관측 수를 기본값으로 표시합니다. 두 값을 모두 0으로 저장하면 노드 계획 검토와 안전 검사를 거쳐 전체 노드를 종료할 수 있습니다. 유휴 자동 축소는 기본 비활성입니다. 아래에서 허용하고 저장하면 유휴 기간과 활동을 재검사한 뒤 보호 기준까지 자동으로 줄입니다.</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="최소 유지 노드 수"><Input type="number" min="0" max="64" step="1" required disabled={busy} value={draft.min} onChange={e => setDraft({ ...draft, min: e.target.value })} /></Field>
              <Field label="보호 기준 노드 수"><Input type="number" min="0" max="64" step="1" required disabled={busy} value={draft.baseline} onChange={e => setDraft({ ...draft, baseline: e.target.value })} /></Field>
              <Field label="유휴 관측 기간 (분)"><Input type="number" min="1" max="1440" step="1" required disabled={busy} value={draft.minutes} onChange={e => setDraft({ ...draft, minutes: e.target.value })} /></Field>
            </div>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.idle} disabled={busy} onChange={e => setDraft({ ...draft, idle: e.target.checked })} />유휴 기간 충족 시 자동 축소 허용</label>
            <p className="text-xs text-fg-muted">편집 기준 v{draft.version} · 서버 v{data.policy?.version ?? 0}</p>
            <div className="flex gap-2"><Button type="submit" disabled={busy || !!snapshot.error}>정책 저장</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => loadPolicy(data.policy)}>정책 다시 읽기</Button></div>
          </form>}
        </details>
        <Field label="목표 노드 수"><Input type="number" min="0" max="64" step="1" value={count} disabled={busy} onChange={e => { setCount(e.target.value); setReview(undefined); }} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !!snapshot.error || snapshot.isFetching} onClick={() => void makePlan('manual')}>변경 계획 검사</Button>
          <Button disabled={busy || !!snapshot.error || !data.idleEligible} onClick={() => void makePlan('idle')}>유휴 정책으로 계획</Button>
          <Button variant="ghost" disabled={busy || snapshot.isFetching} onClick={() => void snapshot.refetch()}>활동 다시 검사</Button>
        </div>
        {data.policy?.idleEnabled && <p className="text-xs text-fg-muted">유휴 최초 관측: {data.idleSince ?? '확인되지 않음'} · {data.idleEligible ? '기간 충족' : '기간 또는 활동 확인 필요'}</p>}
        {data.idleReviewRequired && <p className="text-xs text-warn">같은 관측에서 자동 요청을 이미 처리했습니다. 실패 요청을 자동 반복하지 않습니다. 정책을 다시 검토하거나 수동 계획으로 확인하세요.</p>}
      </>}
      {review?.status === 'BLOCKED' && <ul className="space-y-1 text-sm text-warn" aria-label="계획 차단 사유">{review.blockers.map((b, i) => <li key={`${b.code}:${i}`}>{b.message}</li>)}</ul>}
      {planned && <Card title={`검토: ${planned.from} → ${planned.to}개`}>
        <p className="text-xs text-fg-muted">정책 v{planned.policyVersion} · 만료 {new Date(planned.expiresAt).toISOString()}</p>
        {!!planned.targets.length && <ul aria-label="삭제 대상 노드" className="my-3 space-y-1 text-xs">{planned.targets.map(node => <li key={node.instanceId}>{node.name} · {node.instanceId}</li>)}</ul>}
        <p className="mb-3 text-xs text-fg-muted">축소는 확인한 대상 노드만 사용 중지하고 재검사합니다. 사용자 작업을 강제 축출하지 않습니다.</p>
        <Button variant="primary" disabled={!reviewedCurrent || busy || !!snapshot.error} onClick={() => void execute()}>검토한 계획 실행</Button>
      </Card>}
      {(operation || data?.activeOperationId) && <Card title="용량 요청 상태">
        {operation && <><Badge tone={operation.status === 'SUCCEEDED' ? 'ok' : 'warn'}>{statusLabels[operation.status] ?? '상태 확인 필요'}</Badge><p className="mt-2 text-sm">{operation.message}</p>
          {!!operation.failed?.length && <ul className="mt-2 text-xs">{operation.failed.map((failure, i) => <li key={i}>{failure.NodeId}: {failure.Code} {failure.Message}</li>)}</ul>}</>}
        <Button className="mt-3" disabled={busy} onClick={() => void observe()}>요청 결과 확인</Button>
        <p className="mt-2 text-xs text-fg-muted">용량 요청은 자동으로 재전송하지 않습니다. 확인된 실패 노드의 자체 사용 중지만 복구합니다. AWS 콘솔·별도 자동화와 동시 변경은 조정이 필요합니다.</p>
      </Card>}
      {busy && <Spinner label="검사 또는 요청 처리 중…" />}
      <Button variant="ghost" onClick={onClose}>닫기</Button>
    </div>
  </Dialog>;
}
