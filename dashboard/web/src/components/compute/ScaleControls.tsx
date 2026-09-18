'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api-client';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Spinner } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { ScalePlan, ScalingPolicy, planScale, scaleSnapshot } from '@/server/services/scaling-plans';
type Snapshot = Awaited<ReturnType<typeof scaleSnapshot>>;
type Review = Awaited<ReturnType<typeof planScale>>;
interface PolicyDraft { min: string; baseline: string; minutes: string; idle: boolean; version: number }
export function ScaleControls({ cluster, group, current, onClose, onChanged }: {
  cluster: string; group: string; current: number; onClose(): void; onChanged(): void;
}) {
  const t = useT('scaling');
  const tc = useT('common');
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
      if (numbers.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error(t('errInvalidBaseline'));
      const saved = await api<ScalingPolicy>(`${base}/policy`, { method: 'PUT', json: {
        group, expectedVersion: draft.version, minCount: numbers[0], baselineCount: numbers[1], idleMinutes: numbers[2],
        idleEnabled: draft.idle, observedSpecHash: data.specHash,
      } });
      if (saved.group !== group || saved.version !== draft.version + 1) throw new Error(t('errPolicySave'));
      loadPolicy(saved); setReview(undefined); await snapshot.refetch();
    });
  }
  async function makePlan(mode: 'manual' | 'idle') {
    if (!data || busy) return;
    await action(async () => {
      setReview(undefined); setOperation(undefined);
      const desired = mode === 'idle' ? data.floor : Number(count);
      if (!Number.isSafeInteger(desired) || desired < 0) throw new Error(t('errInvalidTarget'));
      setCount(String(desired));
      const result = await api<Review>(`${base}/plan`, { method: 'POST', json: {
        group, count: desired, expectedCount: data.targetCount, observedSpecHash: data.specHash, mode,
      } });
      if (!['PLANNED', 'BLOCKED'].includes(result?.status)) throw new Error(t('errPlanResponse'));
      setReview(result);
    });
  }
  async function execute() {
    if (!planned || !reviewedCurrent || busy) return;
    await action(async () => {
      const result = await api<ScalePlan>(base, { method: 'POST', json: { planId: planned.id } });
      if (result?.id !== planned.id || !['BLOCKED', 'PREPARING', 'ACCEPTED', 'UNKNOWN', 'SUCCEEDED', 'PARTIAL', 'FAILED'].includes(result.status)) throw new Error(t('errCapacityResponse'));
      setOperation(result); setReview(undefined); await snapshot.refetch(); onChanged();
    });
  }
  async function observe() {
    const id = operation?.id ?? data?.activeOperationId; if (!id || busy) return;
    await action(async () => {
      const result = await api<ScalePlan>(`${base}/reconcile`, { method: 'POST', json: { operationId: id } });
      if (result?.id !== id) throw new Error(t('errObservation'));
      setOperation(result); await snapshot.refetch(); onChanged();
    });
  }
  const statusLabels: Record<string, string> = { PLANNED: t('stPlanned'), PREPARING: t('stPreparing'), ACCEPTED: t('stAccepted'),
    UNKNOWN: t('stUnknown'), SUCCEEDED: t('stSucceeded'), PARTIAL: t('stPartial'), FAILED: t('stFailed'), BLOCKED: t('stBlocked') };
  return <Dialog open onClose={onClose} title={t('title', { group })} width="lg">
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">{t('subtitle', { cluster, backend: data?.backendId ?? t('backendChecking') })}</p>
      <ErrorBox error={snapshot.error} /><ErrorBox error={error} />
      {snapshot.isLoading && <Spinner label={t('checking')} />}
      {data && <>
        <p className="text-sm">{t('current', { current: data.currentCount ?? 'unknown', target: data.targetCount ?? 'unknown', floor: data.policy ? data.floor : 'not set' })}</p>
        {!!data.policy?.protectedInstanceIds?.length && <p className="break-all text-xs text-fg-muted">{t('protectedInstances', { ids: data.policy.protectedInstanceIds.join(', ') })}</p>}
        <p className="text-xs text-fg-muted">{t('observed', { time: data.observedAt })}</p>
        <Card title={t('blockers')}>
          {data.blockers.length ? <ul className="space-y-2 text-sm" aria-label={t('blockers')}>{data.blockers.map((blocker, i) => <li key={`${blocker.code}:${i}`}>
            <code className="text-xs">{blocker.code}</code> · {blocker.message}
            {blocker.resources?.length && <p className="mt-1 break-all text-xs text-fg-muted">{blocker.resources.join(', ')}</p>}
          </li>)}</ul> : <p className="text-sm">{t('noBlockers')}</p>}
        </Card>
        <details>
          <summary className="cursor-pointer text-sm">{t('policy')}</summary>
          {draft && <form onSubmit={savePolicy} className="mt-3 space-y-3">
            <p className="text-xs text-fg-muted">{t('policyDesc')}</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('minNodes')}><Input type="number" min="0" max="64" step="1" required disabled={busy} value={draft.min} onChange={e => setDraft({ ...draft, min: e.target.value })} /></Field>
              <Field label={t('baselineNodes')}><Input type="number" min="0" max="64" step="1" required disabled={busy} value={draft.baseline} onChange={e => setDraft({ ...draft, baseline: e.target.value })} /></Field>
              <Field label={t('idleMinutes')}><Input type="number" min="1" max="1440" step="1" required disabled={busy} value={draft.minutes} onChange={e => setDraft({ ...draft, minutes: e.target.value })} /></Field>
            </div>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.idle} disabled={busy} onChange={e => setDraft({ ...draft, idle: e.target.checked })} />{t('idleCheckbox')}</label>
            <p className="text-xs text-fg-muted">{t('policyVersion', { draft: draft.version, server: data.policy?.version ?? 0 })}</p>
            <div className="flex gap-2"><Button type="submit" disabled={busy || !!snapshot.error}>{t('savPolicy')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => loadPolicy(data.policy)}>{t('loadPolicy')}</Button></div>
          </form>}
        </details>
        <Field label={t('targetNodes')}><Input type="number" min="0" max="64" step="1" value={count} disabled={busy} onChange={e => { setCount(e.target.value); setReview(undefined); }} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !!snapshot.error || snapshot.isFetching} onClick={() => void makePlan('manual')}>{t('makePlan')}</Button>
          <Button disabled={busy || !!snapshot.error || !data.idleEligible} onClick={() => void makePlan('idle')}>{t('idlePlan')}</Button>
          <Button variant="ghost" disabled={busy || snapshot.isFetching} onClick={() => void snapshot.refetch()}>{t('checkAgain')}</Button>
        </div>
        {data.policy?.idleEnabled && <p className="text-xs text-fg-muted">{t('idleEligible', { since: data.idleSince ?? 'unknown', eligible: data.idleEligible ? t('idleReady') : t('idleNotReady') })}</p>}
        {data.idleReviewRequired && <p className="text-xs text-warn">{t('idleReview')}</p>}
      </>}
      {review?.status === 'BLOCKED' && <ul className="space-y-1 text-sm text-warn" aria-label={t('blocked')}>{review.blockers.map((b, i) => <li key={`${b.code}:${i}`}>{b.message}</li>)}</ul>}
      {planned && <Card title={t('review', { from: planned.from, to: planned.to })}>
        <p className="text-xs text-fg-muted">{t('policyV', { v: planned.policyVersion })} · {t('expires', { time: new Date(planned.expiresAt).toISOString() })}</p>
        {!!planned.targets.length && <ul aria-label={t('deleteTargets')} className="my-3 space-y-1 text-xs">{planned.targets.map(node => <li key={node.instanceId}>{node.name} · {node.instanceId}</li>)}</ul>}
        <p className="mb-3 text-xs text-fg-muted">{t('scaleNote')}</p>
        <Button variant="primary" disabled={!reviewedCurrent || busy || !!snapshot.error} onClick={() => void execute()}>{t('execute')}</Button>
      </Card>}
      {(operation || data?.activeOperationId) && <Card title={t('capacity')}>
        {operation && <><Badge tone={operation.status === 'SUCCEEDED' ? 'ok' : 'warn'}>{statusLabels[operation.status] ?? t('stUnknown')}</Badge><p className="mt-2 text-sm">{operation.message}</p>
          {!!operation.failed?.length && <ul className="mt-2 text-xs">{operation.failed.map((failure, i) => <li key={i}>{failure.NodeId}: {failure.Code} {failure.Message}</li>)}</ul>}</>}
        <Button className="mt-3" disabled={busy} onClick={() => void observe()}>{t('observe')}</Button>
        <p className="mt-2 text-xs text-fg-muted">{t('obsNote')}</p>
      </Card>}
      {busy && <Spinner label={t('checking')} />}
      <Button variant="ghost" onClick={onClose}>{t('close')}</Button>
    </div>
  </Dialog>;
}
