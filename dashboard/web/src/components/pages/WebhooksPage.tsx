'use client';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, useApi } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { HookMetadata } from '@/server/services/webhooks';

interface Registry { project: { id: string; name: string }; hooks: HookMetadata[]; canManage: boolean }
interface DeliveryView { id: string; eventId: string; runId: string; eventStatus: string; state: string; attempts: number; totalAttempts: number; redrives: number; createdAt: string; lastError?: string; lastHttpStatus?: number; nextAttemptAt?: number }
const base = '/api/webhooks';
const statuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
const field = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';
export function WebhooksPage() {
  const t = useT('webhooks');
  const tc = useT('common');
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
    <PageHeader title={t('title')} description={<>{registry.data?.project.name ?? tc('project')} · {t('description')}</>} actions={<Badge tone="info">{t('badge')}</Badge>} />
    <ErrorBox error={registry.error ?? error} />
    {notice && <p role="status" className="rounded border border-border p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label={t('pageLabel')} />}
    <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
      <Card title={t('subscriptions')}>
        {!registry.data?.hooks.length && <EmptyState title={t('noHooks')} hint={t('noHooksHint')} />}
        <div className="space-y-2">{registry.data?.hooks.map(value => <button type="button" key={value.id}
          className={`w-full rounded border p-3 text-left ${selected === value.id ? 'border-accent bg-accent/5' : 'border-border'}`}
          onClick={() => { setSelected(value.id); setRotateUrl(''); setRotateSecret(''); }}>
          <span className="flex justify-between gap-2"><span className="font-medium">{value.name}</span>
            <Badge tone={value.state === 'ERROR' ? 'err' : value.enabled ? 'info' : 'neutral'}>{value.state}</Badge></span>
          <span className="mt-2 block text-xs text-fg-muted">{value.statuses.join(' · ')}</span>
        </button>)}</div>
        <p className="mt-4 text-xs leading-5 text-fg-muted">{t('subscriptionNote')}</p>
      </Card>
      <Card title={hook ? `${hook.name} · ${t('recentDeliveries')}` : t('deliveries')}>
        <ErrorBox error={deliveries.error} />
        {!hook ? <EmptyState title={t('selectSubscription')} /> : <>
          {registry.data?.canManage && <div className="mb-4 flex gap-2"><Button disabled={busy} onClick={() => void action(async () => {
            await api(`${base}/${hook.id}`, { method: 'PATCH', json: { enabled: !hook.enabled } });
            await registry.refetch(); setNotice(hook.enabled ? t('deliveryDisabledNote') : t('deliveryEnabledNote'));
          })}>{hook.enabled ? t('deliveryDisabled') : t('deliveryEnabled')}</Button></div>}
          {!deliveries.data?.length && <EmptyState title={t('noDeliveries')} hint={t('deliveriesHint')} />}
          <div className="space-y-3">{deliveries.data?.map(delivery => <section key={delivery.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-mono text-xs">{delivery.runId} · {delivery.eventStatus}</span>
              <Badge tone={delivery.state === 'DEAD' ? 'err' : delivery.state === 'DELIVERED' ? 'info' : 'warn'}>{delivery.state}</Badge></div>
            <p className="mt-2 text-xs text-fg-muted">{t('attempts', { attempts: delivery.attempts, total: delivery.totalAttempts, redrive: delivery.redrives })}{delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ''}</p>
            {delivery.lastError && <p className="mt-1 text-xs text-fg-muted">{delivery.lastError}</p>}
            <p className="mt-1 break-all font-mono text-[11px] text-fg-faint">{delivery.eventId}</p>
            {registry.data?.canManage && hook.enabled && ['DEAD', 'CANCELLED'].includes(delivery.state) &&
              <Button className="mt-2" size="sm" disabled={busy} onClick={() => void action(async () => {
                await api(`${base}/${hook.id}/deliveries/${delivery.id}/redrive`, { method: 'POST', json: {} });
                await deliveries.refetch(); setNotice(t('redriveScheduled'));
              })}>{t('deliveryRetry')}</Button>}
          </section>)}</div>
        </>}
      </Card>
    </div>
    {registry.data?.canManage && <Card title={t('newSubscription')}>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={event => { event.preventDefault(); void action(async () => {
        try {
          const saved = await api<HookMetadata>(base, { method: 'POST', json: { name, endpointUrl: url, secret, statuses: events } });
          await registry.refetch(); setSelected(saved.id); setName(''); setUrl(''); setNotice(t('registrationSuccess'));
        } finally { setSecret(''); }
      }); }}>
        <label className="text-xs text-fg-muted">{t('subscriptionName')}<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} className={field} /></label>
        <label className="text-xs text-fg-muted">{t('receiverUrl')}<input type="url" required autoComplete="off" maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} className={field} placeholder={t('receiverPlaceholder')} /></label>
        <label className="text-xs text-fg-muted">{t('signingKey')}<input type="password" required autoComplete="new-password" minLength={32} maxLength={256} value={secret} onChange={e => setSecret(e.target.value)} className={field} /></label>
        <fieldset><legend className="text-xs text-fg-muted">{t('endpointStatuses')}</legend><div className="mt-3 flex flex-wrap gap-3">
          {statuses.map(status => {
            const label = status === 'SUCCEEDED' ? t('statusSucceeded') : status === 'FAILED' ? t('statusFailed') : t('statusCancelled');
            return <label key={status} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={events.includes(status)}
            onChange={e => setEvents(values => e.target.checked ? [...values, status] : values.filter(value => value !== status))} />{label}</label>;
          })}
        </div></fieldset>
        <p className="text-xs leading-5 text-fg-muted md:col-span-2">{t('subscriptionNote2')}</p>
        <div><Button type="submit" variant="primary" loading={busy} disabled={!events.length}>{t('registerSubscription')}</Button></div>
      </form>
    </Card>}
    {hook && registry.data?.canManage && <Card title={`${hook.name} · ${t('rotateTitle')}`}>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={event => { event.preventDefault(); void action(async () => {
        try {
          await api(`${base}/${hook.id}/rotate`, { method: 'POST', json: { secret: rotateSecret, ...(rotateUrl ? { endpointUrl: rotateUrl } : {}) } });
          await registry.refetch(); setRotateUrl(''); setNotice(t('rotateSuccess'));
        } finally { setRotateSecret(''); }
      }); }}>
        <label className="text-xs text-fg-muted">{t('newKey')}<input type="password" autoComplete="new-password" required minLength={32} maxLength={256} value={rotateSecret} onChange={e => setRotateSecret(e.target.value)} className={field} /></label>
        <label className="text-xs text-fg-muted">{t('newUrl')}<input type="url" autoComplete="off" maxLength={2048} value={rotateUrl} onChange={e => setRotateUrl(e.target.value)} className={field} /></label>
        <div><Button type="submit" loading={busy}>{t('rotateSubmit')}</Button></div>
      </form>
    </Card>}
  </div>;
}
