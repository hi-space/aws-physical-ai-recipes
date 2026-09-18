'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api-client';
import { Badge, Button, Card, ErrorBox } from '@/components/ui';

export function DcvBrowserCard() {
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
      if (url.protocol !== 'https:' || !url.hostname.startsWith(`${created.id}.`) || !url.searchParams.get('ticket')) throw new Error('안전한 세션 주소를 확인할 수 없습니다.');
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
  return <Card title="Isaac Sim 데스크톱" description="기존 워크숍 워크스테이션 · 관리자 전용 공유 환경" className="mb-5">
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={state.data?.configured ? 'ok' : 'warn'}>{state.data?.configured ? '브라우저 연결 준비됨' : state.data?.status ?? '연결 준비 필요'}</Badge>
      {state.data?.configured
        ? <>
          <Button variant="primary" loading={busy} onClick={() => open(true)}>여기서 보기</Button>
          <Button loading={busy} onClick={() => open(false)}>새 창에서 열기</Button>
        </>
        : <Button loading={busy || state.data?.status === 'CONFIGURING'} onClick={prepare}>브라우저 연결 준비</Button>}
      {session && <Button onClick={close} loading={busy}>내 연결 종료</Button>}
    </div>
    <p className="mt-3 text-xs text-fg-muted">Cognito 로그인으로 데스크톱을 엽니다. 접속은 1시간 동안 유효하며, 종료해도 공유 워크스테이션과 기존 작업은 유지됩니다.</p>
    {embed && (
      <div className="mt-3">
        <iframe src={embed} title="Isaac Sim DCV 데스크톱" className="h-[75vh] w-full rounded-md border border-border bg-black" allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="no-referrer" />
        <div className="mt-1 flex items-center justify-between text-xs text-fg-muted">
          <span>DCV 웹 클라이언트 · 세션 호스트 origin에서 실행되며 만료 시 끊깁니다.</span>
          <Button size="sm" variant="ghost" onClick={() => setEmbed(undefined)}>닫기</Button>
        </div>
      </div>
    )}
    {(error || state.error || state.data?.error) && <ErrorBox error={error ?? state.error ?? state.data?.error} />}
  </Card>;
}
