'use client';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import type { HookMetadata } from '@/server/services/webhooks';

interface Registry { project: { id: string; name: string }; hooks: HookMetadata[]; canManage: boolean }
interface DeliveryView { id: string; eventId: string; runId: string; eventStatus: string; state: string; attempts: number; totalAttempts: number; redrives: number; createdAt: string; lastError?: string; lastHttpStatus?: number; nextAttemptAt?: number }
const base = '/api/webhooks';
const statuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
const field = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';
export function WebhooksPage() {
  const registry = useApi<Registry>(base);
  const [selected, setSelected] = React.useState('');
  const deliveries = useApi<DeliveryView[]>(selected ? `${base}/${selected}/deliveries` : null, { refetch: 10000 });
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [events, setEvents] = React.useState<string[]>([...statuses]);
  const [rotateUrl, setRotateUrl] = React.useState('');
  const [rotateSecret, setRotateSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const [notice, setNotice] = React.useState('');
  const hook = registry.data?.hooks.find(value => value.id === selected);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await work(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
      <div><p className="text-xs uppercase tracking-wider text-fg-faint">WORKFLOW EVENTS / DELIVERY LEDGER</p>
        <h1 className="mt-1 text-2xl font-semibold">프로젝트 웹훅</h1>
        <p className="mt-2 text-sm text-fg-muted">{registry.data?.project.name ?? '프로젝트'} · 종료 이벤트 구독과 전달 이력</p></div>
      <Badge tone="info">서명된 이벤트 · 중복 수신 가능</Badge>
    </header>
    <ErrorBox error={registry.error ?? error} />
    {notice && <p role="status" className="rounded border border-border p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label="웹훅을 읽는 중…" />}
    <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
      <Card title="구독">
        {!registry.data?.hooks.length && <EmptyState title="등록된 웹훅이 없습니다." hint="프로젝트 관리자가 수신 서버와 공유 서명 키를 등록할 수 있습니다." />}
        <div className="space-y-2">{registry.data?.hooks.map(value => <button type="button" key={value.id}
          className={`w-full rounded border p-3 text-left ${selected === value.id ? 'border-accent bg-accent/5' : 'border-border'}`}
          onClick={() => { setSelected(value.id); setRotateUrl(''); setRotateSecret(''); }}>
          <span className="flex justify-between gap-2"><span className="font-medium">{value.name}</span>
            <Badge tone={value.state === 'ERROR' ? 'err' : value.enabled ? 'info' : 'neutral'}>{value.state}</Badge></span>
          <span className="mt-2 block text-xs text-fg-muted">{value.statuses.join(' · ')}</span>
        </button>)}</div>
        <p className="mt-4 text-xs leading-5 text-fg-muted">수신 URL과 서명 키는 암호화 저장되며 조회 화면에 반환되지 않습니다. 등록·키 교체는 테스트 메시지를 보내지 않습니다.</p>
      </Card>
      <Card title={hook ? `${hook.name} · 최근 50건` : '전달 이력'}>
        <ErrorBox error={deliveries.error} />
        {!hook ? <EmptyState title="구독을 선택하세요." /> : <>
          {registry.data?.canManage && <div className="mb-4 flex gap-2"><Button disabled={busy} onClick={() => void action(async () => {
            await api(`${base}/${hook.id}`, { method: 'PATCH', json: { enabled: !hook.enabled } });
            await registry.refetch(); setNotice(hook.enabled ? '구독을 중지했습니다. 기존 이력과 암호화 설정은 보존됩니다.' : '구독을 다시 활성화했습니다.');
          })}>{hook.enabled ? '구독 중지' : '구독 활성화'}</Button></div>}
          {!deliveries.data?.length && <EmptyState title="아직 전달 기록이 없습니다." hint="worker 연결 후 구독 상태에 맞는 새 종료 이벤트가 기록됩니다." />}
          <div className="space-y-3">{deliveries.data?.map(delivery => <section key={delivery.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-mono text-xs">{delivery.runId} · {delivery.eventStatus}</span>
              <Badge tone={delivery.state === 'DEAD' ? 'err' : delivery.state === 'DELIVERED' ? 'info' : 'warn'}>{delivery.state}</Badge></div>
            <p className="mt-2 text-xs text-fg-muted">시도 {delivery.attempts}회 · 전체 {delivery.totalAttempts}회 · 재전달 {delivery.redrives}회{delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ''}</p>
            {delivery.lastError && <p className="mt-1 text-xs text-fg-muted">{delivery.lastError}</p>}
            <p className="mt-1 break-all font-mono text-[11px] text-fg-faint">{delivery.eventId}</p>
            {registry.data?.canManage && hook.enabled && ['DEAD', 'CANCELLED'].includes(delivery.state) &&
              <Button className="mt-2" size="sm" disabled={busy} onClick={() => void action(async () => {
                await api(`${base}/${hook.id}/deliveries/${delivery.id}/redrive`, { method: 'POST', json: {} });
                await deliveries.refetch(); setNotice('현재 설정으로 재전달을 예약했습니다. 이벤트 ID는 유지됩니다.');
              })}>현재 설정으로 재전달 예약</Button>}
          </section>)}</div>
        </>}
      </Card>
    </div>
    {registry.data?.canManage && <Card title="새 구독 등록">
      <form className="grid gap-4 md:grid-cols-2" onSubmit={event => { event.preventDefault(); void action(async () => {
        try {
          const saved = await api<HookMetadata>(base, { method: 'POST', json: { name, endpointUrl: url, secret, statuses: events } });
          await registry.refetch(); setSelected(saved.id); setName(''); setUrl(''); setNotice('웹훅을 등록했습니다. 서명 키는 다시 조회할 수 없습니다.');
        } finally { setSecret(''); }
      }); }}>
        <label className="text-xs text-fg-muted">구독 이름<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} className={field} /></label>
        <label className="text-xs text-fg-muted">수신 HTTPS URL<input type="url" required autoComplete="off" maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} className={field} placeholder="https://receiver.example.com/events" /></label>
        <label className="text-xs text-fg-muted">공유 서명 키<input type="password" required autoComplete="new-password" minLength={32} maxLength={256} value={secret} onChange={e => setSecret(e.target.value)} className={field} /></label>
        <fieldset><legend className="text-xs text-fg-muted">종료 상태</legend><div className="mt-3 flex flex-wrap gap-3">
          {statuses.map(status => <label key={status} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={events.includes(status)}
            onChange={e => setEvents(values => e.target.checked ? [...values, status] : values.filter(value => value !== status))} />{status}</label>)}
        </div></fieldset>
        <p className="text-xs leading-5 text-fg-muted md:col-span-2">수신 서버와 같은 무작위 키를 사용하세요. 본문에는 실행 ID, 프로젝트, 이름, 종료 상태와 시각만 포함됩니다. 수신자는 이벤트 ID로 중복을 처리해야 합니다.</p>
        <div><Button type="submit" variant="primary" loading={busy} disabled={!events.length}>구독 등록</Button></div>
      </form>
    </Card>}
    {hook && registry.data?.canManage && <Card title={`${hook.name} · 키 또는 수신 URL 교체`}>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={event => { event.preventDefault(); void action(async () => {
        try {
          await api(`${base}/${hook.id}/rotate`, { method: 'POST', json: { secret: rotateSecret, ...(rotateUrl ? { endpointUrl: rotateUrl } : {}) } });
          await registry.refetch(); setRotateUrl(''); setNotice('설정을 교체했습니다. 이전 설정에 묶인 대기 전달은 취소되며, 필요하면 명시적으로 재전달하세요.');
        } finally { setRotateSecret(''); }
      }); }}>
        <label className="text-xs text-fg-muted">새 서명 키<input type="password" autoComplete="new-password" required minLength={32} maxLength={256} value={rotateSecret} onChange={e => setRotateSecret(e.target.value)} className={field} /></label>
        <label className="text-xs text-fg-muted">새 HTTPS URL (빈칸이면 기존 유지)<input type="url" autoComplete="off" maxLength={2048} value={rotateUrl} onChange={e => setRotateUrl(e.target.value)} className={field} /></label>
        <div><Button type="submit" loading={busy}>암호화 설정 교체</Button></div>
      </form>
    </Card>}
  </div>;
}
