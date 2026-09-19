'use client';
import { useState } from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import { Badge, Button, Card, ErrorBox } from '@/components/ui';
import { isSafeLaunchUrl } from '@/lib/session-url';

export function DcvBrowserCard() {
  const t = useT('sessions');
  const me = useMe();
  const pathMode = me.data?.gateway?.mode === 'path';
  const state = useApi<{ configured: boolean; status?: string; error?: string }>('/api/sessions/dcv/browser', { refetch: 5000 });
  const [session, setSession] = useState<{ id: string; expiresAt: string }>();
  const [embed, setEmbed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function prepare() {
    setBusy(true); setError(undefined);
    try { await api('/api/sessions/dcv/browser', { method: 'POST', json: { action: 'configure' } }); await state.refetch(); }
    catch (value) { setError(value); } finally { setBusy(false); }
  }
  async function open(embedded = false) {
    // Embedded: the session host is same-site, so the one-time ticket exchange inside the iframe sets the
    // session cookie and the gateway allows this dashboard origin as the only frame ancestor.
    const tab = embedded ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(true); setError(undefined);
    try {
      const created = session && Date.parse(session.expiresAt) > Date.now()
        ? session : await api<{ id: string; expiresAt: string }>('/api/sessions/dcv/browser', { method: 'POST', json: { action: 'create', ttlMinutes: 60 } });
      setSession(created);
      const launch = await api<{ url: string }>(`/api/sessions/dcv/browser/${created.id}`, { method: 'POST' });
      const url = new URL(launch.url);
      if (!isSafeLaunchUrl(url, created.id, me.data?.gateway)) throw new Error(t('adminDcvError', { error: 'Invalid session URL' }));
      if (embedded) setEmbed(url.toString());
      else if (tab) tab.location.href = url.toString(); else window.location.href = url.toString();
    } catch (value) { tab?.close(); setError(value); } finally { setBusy(false); }
  }
  async function close() {
    if (!session) return;
    setBusy(true);
    try { await api(`/api/sessions/dcv/browser/${session.id}`, { method: 'DELETE' }); setSession(undefined); setEmbed(undefined); }
    catch (value) { setError(value); } finally { setBusy(false); }
  }
  return <Card title={t('dcvBrowserCardTitle')} description={t('dcvBrowserCardDesc')} className="mb-5">
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={state.data?.configured ? 'ok' : 'warn'}>{state.data?.configured ? t('dcvBrowserReady') : state.data?.status ?? t('dcvBrowserNotReady')}</Badge>
      {state.data?.configured
        ? <>
          {!pathMode && <Button variant="primary" loading={busy} onClick={() => open(true)}>{t('dcvBrowserViewHere')}</Button>}
          <Button variant={pathMode ? 'primary' : undefined} loading={busy} onClick={() => open(false)}>{t('dcvBrowserOpenNew')}</Button>
        </>
        : <Button loading={busy || state.data?.status === 'CONFIGURING'} onClick={prepare}>{t('dcvBrowserSetup')}</Button>}
      {session && <Button onClick={close} loading={busy}>{t('dcvBrowserCloseConnection')}</Button>}
    </div>
    <p className="mt-3 text-xs text-fg-muted">{t('dcvBrowserInfo')}</p>
    {embed && (
      <div className="mt-3">
        <iframe src={embed} title={t('dcvBrowserTitle')} className="h-[75vh] w-full rounded-md border border-border bg-black" allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="no-referrer" />
        <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
          <span>{t('dcvBrowserClient')}</span>
          <Button size="sm" variant="ghost" onClick={() => setEmbed(undefined)}>{t('dcvBrowserClose')}</Button>
        </div>
      </div>
    )}
    {(error || state.error || state.data?.error) && <ErrorBox error={error ?? state.error ?? state.data?.error} />}
  </Card>;
}
