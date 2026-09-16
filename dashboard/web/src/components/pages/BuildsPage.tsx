'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api-client';
import { Button, Card, ErrorBox, EmptyState, StatusPill } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

export function BuildsPage() {
  const projects = useApi<Array<{ name: string; description?: string; sourceType?: string }>>('/api/builds');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const builds = useApi<Array<{ id: string; status: string; phase?: string; startedAt?: string; resolvedSourceVersion?: string }>>(selected ? `/api/builds?project=${encodeURIComponent(selected)}` : null, { refetch: 5000 });
  async function start() {
    setError(undefined); setBusy(true);
    try { await api('/api/builds', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, json: { project: selected } }); await builds.refetch(); }
    catch (value) { setError(value); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="환경 빌드·동기화" />
    <p className="mb-4 text-sm text-fg-muted">등록된 CodeBuild 작업을 실행하고 소스 버전과 진행 상태를 확인합니다. Operations 작업은 프로젝트 실행 권한과 네트워크 정책을 동기화합니다.</p>
    {(error || projects.error || builds.error) && <ErrorBox error={error ?? projects.error ?? builds.error} />}
    <Card title="실행할 작업">
      <div className="flex flex-wrap gap-3">
        <select aria-label="빌드 프로젝트" className="rounded border border-border bg-bg px-3 py-2 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">프로젝트 선택</option>{projects.data?.map((project) => <option key={project.name} value={project.name}>{project.name}</option>)}
        </select>
        <Button variant="primary" disabled={!selected} loading={busy} onClick={start}>작업 시작</Button>
      </div>
    </Card>
    <Card className="mt-5" title="실행 이력">
      {!builds.data?.length && <EmptyState title="아직 실행 이력이 없습니다." />}
      <div className="space-y-3">{builds.data?.map((build) => <div key={build.id} className="rounded border border-border bg-bg p-3">
        <div className="flex flex-wrap items-center gap-3"><StatusPill status={build.status} /><span className="text-sm">{build.phase}</span><span className="text-xs text-fg-muted">{build.startedAt}</span></div>
        <div className="mt-2 break-all font-mono text-xs">{build.id}</div>
        {build.resolvedSourceVersion && <p className="mt-1 break-all text-xs text-fg-muted">소스: {build.resolvedSourceVersion}</p>}
      </div>)}</div>
    </Card>
  </>;
}
