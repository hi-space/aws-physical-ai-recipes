'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, can, useApi, useMe } from '@/lib/api-client';
import { Bar, Button, Card, Dialog, EmptyState, ErrorBox, Input, LinkButton, Select, StatusPill } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ago, fmtDuration } from '@/lib/format';
import type { Workflow } from '@/server/store/types';

export function WorkflowsPage() {
  const me = useMe();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{ action: 'cancel' | 'delete'; ids: string[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCursor(undefined); setHistory([]); setSelected([]); }, [query, status]);
  const params = new URLSearchParams({ page: '1', status, q: query });
  if (cursor) params.set('cursor', cursor);
  const page = useApi<{ items: Workflow[]; cursor?: string }>(`/api/workflows?${params}`, { refetch: 5000 });
  const workflows = page.data?.items ?? [];
  const canWrite = can(me.data, 'researcher') && (me.data?.role === 'admin' || me.data?.project?.role !== 'viewer');
  const owns = (workflow: Workflow) => me.data?.role === 'admin' || (workflow.ownerSubject ? workflow.ownerSubject === me.data?.subject : workflow.owner === me.data?.user);
  const active = (workflow: Workflow) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(workflow.status);
  async function apply() {
    if (!confirmation) return;
    setBusy(true); setError(undefined);
    try {
      if (confirmation.action === 'cancel') {
        const result = await api<{ requested: string[]; failed: string[] }>('/api/workflows/bulk-cancel', { method: 'POST', json: { ids: confirmation.ids } });
        setNotice(`${result.requested.length}개 실행에 취소를 요청했습니다.${result.failed.length ? ` ${result.failed.length}개는 다시 시도해 주세요.` : ''}`);
      } else {
        await api(`/api/workflows/${confirmation.ids[0]}`, { method: 'DELETE' });
        setNotice('실행 이력을 삭제했습니다.');
      }
      setConfirmation(undefined); setSelected([]); await page.refetch();
    } catch (value) { setError(value); } finally { setBusy(false); }
  }
  async function retry(workflow: Workflow) {
    setError(undefined);
    try {
      const result = await api<{ id: string }>(`/api/workflows/${workflow.id}/retry`, { method: 'POST' });
      window.location.href = `/workflows/${result.id}`;
    } catch (value) { setError(value); }
  }
  return <div className="space-y-5">
    <PageHeader title="파이프라인 실행" actions={canWrite && <LinkButton href="/workflows/new" variant="primary">새 실험 시작</LinkButton>} />
    <p className="text-sm text-fg-muted">작업 흐름과 실행 이력을 확인합니다. 실행을 열면 단계별 로그, 메트릭, 데이터와 개발 세션으로 이어집니다.</p>
    {(error || page.error) && <ErrorBox error={error ?? page.error} />}
    {notice && <p role="status" className="text-sm text-info">{notice}</p>}
    <div className="flex flex-wrap gap-3">
      <label className="block max-w-md">
        <span className="sr-only">전체 실행 이력에서 이름·ID·소유자 검색</span>
        <Input className="max-w-md" value={search} placeholder="전체 이력에서 이름·ID·소유자 검색" onChange={(event) => setSearch(event.target.value)} />
        {(page.data as { scanLimited?: boolean } | undefined)?.scanLimited && <span role="status" className="mt-1 block text-xs text-fg-muted">아직 검색하지 않은 이력이 있습니다. 다음 페이지에서 계속 검색하세요.</span>}
      </label>
      <Select className="max-w-48" aria-label="실행 상태" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">모든 상태</option><option value="PENDING">대기</option><option value="RUNNING">실행 중</option><option value="FINALIZING">결과 저장 중</option><option value="SUCCEEDED">완료</option><option value="FAILED">실패</option><option value="CANCELLING">취소 중</option><option value="CANCELLED">취소됨</option>
      </Select>
      {canWrite && selected.length > 0 && <Button variant="danger" onClick={() => setConfirmation({ action: 'cancel', ids: selected })}>선택 취소 ({selected.length})</Button>}
    </div>
    <Card padded={false}>
      {!workflows.length ? <div className="p-5"><EmptyState title={page.isLoading ? '실행 목록을 불러오는 중…' : '표시할 실행이 없습니다.'} hint={query || status ? '필터를 변경하거나 다음 페이지를 확인하세요.' : '레시피를 선택해 첫 실험을 시작하세요.'} /></div> : <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th aria-label="선택" /><th>실험</th><th>상태</th><th>진행</th><th>소유자</th><th>시작</th><th>소요 시간</th><th>작업</th></tr></thead>
        <tbody>{workflows.map((workflow) => <tr key={workflow.id}>
          <td>{canWrite && owns(workflow) && active(workflow) && <input type="checkbox" aria-label={`${workflow.name} 선택`} checked={selected.includes(workflow.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, workflow.id] : current.filter((id) => id !== workflow.id))} />}</td>
          <td><Link className="font-medium text-accent hover:underline" href={`/workflows/${workflow.id}`}>{workflow.name}</Link><div className="mt-1 font-mono text-[11px] text-fg-faint">{workflow.id}</div></td>
          <td><StatusPill status={workflow.status} /></td>
          <td><div className="flex min-w-24 items-center gap-2"><Bar value={workflow.succeededCount} max={workflow.taskCount || 1} tone={workflow.failedCount ? 'err' : 'ok'} /><span className="text-xs">{workflow.succeededCount}/{workflow.taskCount}</span></div></td>
          <td className="text-xs">{workflow.owner}</td><td className="text-xs">{ago(workflow.createdAt)}</td>
          <td className="text-xs">{workflow.startedAt ? fmtDuration(Date.parse(workflow.finishedAt ?? new Date().toISOString()) - Date.parse(workflow.startedAt)) : '—'}</td>
          <td><div className="flex gap-1">
            {canWrite && owns(workflow) && active(workflow) && <Button size="sm" onClick={() => setConfirmation({ action: 'cancel', ids: [workflow.id] })}>취소</Button>}
            {canWrite && !active(workflow) && <Button size="sm" onClick={() => retry(workflow)}>재실행</Button>}
            {canWrite && owns(workflow) && !active(workflow) && <Button size="sm" variant="ghost" onClick={() => setConfirmation({ action: 'delete', ids: [workflow.id] })}>삭제</Button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </Card>
    <div className="flex items-center justify-between"><span className="text-xs text-fg-muted">페이지 {history.length + 1} · 최대 50개</span><div className="flex gap-2">
      <Button disabled={!history.length} onClick={() => { setCursor(history.at(-1)); setHistory((current) => current.slice(0, -1)); setSelected([]); }}>이전</Button>
      <Button disabled={!page.data?.cursor} onClick={() => { setHistory((current) => [...current, cursor]); setCursor(page.data?.cursor); setSelected([]); }}>다음</Button>
    </div></div>
    <Dialog open={Boolean(confirmation)} onClose={() => setConfirmation(undefined)} title={confirmation?.action === 'cancel' ? '선택한 실행을 취소할까요?' : '실행 이력을 삭제할까요?'} footer={<><Button onClick={() => setConfirmation(undefined)}>돌아가기</Button><Button variant="danger" loading={busy} onClick={apply}>확인</Button></>}>
      {confirmation?.action === 'cancel' ? `${confirmation.ids.length}개 실행의 작업과 연결을 종료합니다. 저장된 결과는 유지됩니다.` : '선택한 실행의 상세 이력이 삭제됩니다.'}
    </Dialog>
  </div>;
}
