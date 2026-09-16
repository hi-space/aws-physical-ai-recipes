'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Button, Card, ErrorBox, EmptyState, LinkButton, StatusPill } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import type { SourceBuildView, SourceRegistrationView } from '@/server/services/source-builds';

export function BuildsPage() {
  const me = useMe(), project = me.data?.project, scope = project?.id;
  const admin = me.data?.role === 'admin';
  const canBuild = !!scope && (admin || me.data?.role === 'researcher' && ['researcher', 'project-admin'].includes(project?.role ?? ''));
  const canRegister = canBuild && (admin || project?.role === 'project-admin');
  const headers = scope ? { 'x-pai-project': scope } : undefined;
  const [sourceCursor, setSourceCursor] = useState<string>();
  const [historyCursor, setHistoryCursor] = useState<string>();
  const sourcePath = scope ? `/api/builds/sources?projectId=${encodeURIComponent(scope)}${sourceCursor ? `&cursor=${encodeURIComponent(sourceCursor)}` : ''}` : null;
  const historyPath = scope ? `/api/builds/runs?projectId=${encodeURIComponent(scope)}${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}` : null;
  const catalog = useApi<{ projectId: string; targets: { id: string; sourceType: string; codeBuildProjectName: string }[];
    sources: SourceRegistrationView[]; cursor?: string }>(sourcePath, { init: { headers } });
  const runs = useApi<{ items: SourceBuildView[]; cursor?: string }>(historyPath, { refetch: 5000, init: { headers } });
  const [targetId, setTargetId] = useState(''), [name, setName] = useState('');
  const [sourceId, setSourceId] = useState(''), [commit, setCommit] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [recoveryId, setRecoveryId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState('');
  const request = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const source = catalog.data?.sources.find(value => value.id === sourceId);
  const detail = useApi<SourceBuildView>(scope && selectedRun ? `/api/builds/runs/${encodeURIComponent(selectedRun)}?projectId=${encodeURIComponent(scope)}` : null,
    { refetch: 5000, init: { headers } });
  const output = useApi<{ lines: string[]; truncated: boolean }>(scope && detail.data?.buildId
    ? `/api/builds/runs/${encodeURIComponent(selectedRun)}/logs?projectId=${encodeURIComponent(scope)}` : null,
  { refetch: 5000, init: { headers } });
  useEffect(() => {
    setTargetId(''); setName(''); setSourceId(''); setCommit(''); setSelectedRun(''); setRecoveryId('');
    setSourceCursor(undefined); setHistoryCursor(undefined); setError(undefined); setNotice(''); request.current = undefined;
    const requested = new URLSearchParams(window.location.search).get('run');
    if (scope && requested && /^sb-[a-f0-9]{32}$/.test(requested)) setSelectedRun(requested);
  }, [scope]);
  async function registerSource() {
    if (!canRegister || busy) return;
    setBusy(true); setError(undefined); setNotice('');
    try {
      const value = await api<SourceRegistrationView>('/api/builds/sources', { method: 'POST', headers, json: { targetId, name } });
      setSourceCursor(undefined); await catalog.refetch(); setSourceId(value.id);
      setNotice('프로젝트 빌드 출처를 등록했습니다.');
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function startSource() {
    if (!canBuild || !source?.current || busy) return;
    const input = { sourceId, ...(source.sourceType === 'S3' ? {} : { commit: commit.toLowerCase() }) };
    const fingerprint = JSON.stringify([scope, input]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError(undefined); setNotice('');
    try {
      const value = await api<SourceBuildView>('/api/builds/runs', { method: 'POST',
        headers: { ...headers, 'idempotency-key': request.current.key }, json: input });
      setSelectedRun(value.id); setHistoryCursor(undefined); await runs.refetch();
      request.current = undefined; setNotice('빌드 요청을 저장했습니다.');
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function cancelSource(run: SourceBuildView) {
    setBusy(true); setError(undefined);
    try { await api(`/api/builds/runs/${encodeURIComponent(run.id)}`, { method: 'POST', headers, json: { action: 'cancel' } });
      await detail.refetch(); await runs.refetch(); setNotice('취소를 요청했습니다. 종료 확인까지 실행 상태를 표시합니다.');
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function recoverSource() {
    if (!canRegister || busy || !selectedRun) return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/builds/runs/${encodeURIComponent(selectedRun)}/recover`, { method: 'POST', headers, json: { buildId: recoveryId } });
      await detail.refetch(); await runs.refetch(); setRecoveryId(''); setNotice('요청 식별자가 일치하는 실행을 연결했습니다.');
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader title="환경 빌드·동기화" description="프로젝트 소스를 불변 이미지로 빌드하고 소스 버전과 결과 digest를 추적합니다." />
    <ErrorBox error={me.error ?? error ?? catalog.error ?? runs.error} />
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!scope ? <EmptyState title="연구 프로젝트를 선택하세요." hint="소스 등록과 빌드 이력은 선택한 프로젝트에 속합니다." /> : <>
      <Card title={`${project?.name ?? scope} · 빌드 출처`}>
        {!catalog.isLoading && !catalog.error && !catalog.data?.targets.length && <EmptyState title="등록된 소스 빌드 작업이 없습니다."
          hint="플랫폼 관리자가 이 프로젝트의 CodeBuild 작업과 ECR 저장소를 연결해야 합니다." />}
        {canRegister && !!catalog.data?.targets.length && <div className="mb-5 flex flex-wrap gap-3">
          <select aria-label="등록할 소스 작업" value={targetId} onChange={event => setTargetId(event.target.value)}
            className="rounded border border-border bg-bg px-3 py-2 text-sm">
            <option value="">등록된 작업 선택</option>{catalog.data.targets.map(target =>
              <option key={target.id} value={target.id}>{target.id} · {target.sourceType}</option>)}
          </select>
          <input aria-label="빌드 출처 이름" value={name} maxLength={80} onChange={event => setName(event.target.value)}
            className="rounded border border-border bg-bg px-3 py-2 text-sm" placeholder="예: 연구 코드 스냅샷" />
          <Button disabled={!targetId || !name.trim() || busy} onClick={() => void registerSource()}>출처 등록</Button>
        </div>}
        <label className="block text-sm">등록된 빌드 출처
          <select aria-label="등록된 빌드 출처" value={sourceId} onChange={event => { setSourceId(event.target.value); setCommit(''); request.current = undefined; }}
            className="mt-2 block w-full rounded border border-border bg-bg px-3 py-2">
            <option value="">출처 선택</option>{catalog.data?.sources.map(value =>
              <option key={value.id} value={value.id} disabled={!value.current}>{value.name} · {value.sourceType}{value.current ? '' : ' · 구성 변경됨'}</option>)}
          </select>
        </label>
        {source && <div className="mt-3 space-y-2 break-all text-xs text-fg-muted">
          <p>{source.repositoryUrl ?? `S3 스냅샷 · ${source.snapshot?.versionId}`}</p>
          {source.snapshot && <p>소스 SHA256: {source.snapshot.sha256}</p>}
          <p>등록 해시: {source.contentHash}</p>
          <p>Dockerfile: {source.dockerfile} · context: {source.context}</p>
        </div>}
        {!!catalog.data?.cursor && <Button size="sm" className="mt-3" onClick={() => { setSourceCursor(catalog.data?.cursor); setSourceId(''); }}>이전 출처 보기</Button>}
        {sourceCursor && <Button size="sm" className="mt-3" onClick={() => { setSourceCursor(undefined); setSourceId(''); }}>최근 출처 보기</Button>}
        {canBuild && <div className="mt-4 flex flex-wrap items-end gap-3">
          {source && source.sourceType !== 'S3' && <label className="min-w-80 flex-1 text-sm">전체 Git commit SHA
            <input aria-label="전체 Git commit SHA" value={commit} maxLength={40} onChange={event => { setCommit(event.target.value); request.current = undefined; }}
              className="mt-2 block w-full rounded border border-border bg-bg px-3 py-2 font-mono text-xs" placeholder="40자리 commit SHA" />
          </label>}
          <Button variant="primary" loading={busy} disabled={!source?.current || !!catalog.error ||
            source.sourceType !== 'S3' && !/^[a-fA-F0-9]{40}$/.test(commit)} onClick={() => void startSource()}>이미지 빌드 시작</Button>
        </div>}
        <p className="mt-4 text-xs text-fg-muted">워크플로 실행 전 이미지 프로필 승인과 실행 환경 검증이 필요합니다. 빌드 이력에는 검사한 소스와 결과 이미지 digest를 보관합니다.</p>
      </Card>
      <Card title="프로젝트 빌드 이력">
        {!runs.isLoading && !runs.error && !runs.data?.items.length && <EmptyState title="아직 소스 빌드 이력이 없습니다." />}
        <div className="space-y-3">{runs.data?.items.map(run => <button key={run.id} type="button"
          onClick={() => { setSelectedRun(run.id); setRecoveryId(''); }} className="block w-full rounded border border-border bg-bg p-3 text-left">
          <span className="flex flex-wrap items-center gap-3"><StatusPill status={run.state} /><span className="text-xs text-fg-muted">{run.createdAt}</span></span>
          <span className="mt-2 block break-all font-mono text-xs">{run.id}</span>
          <span className="mt-1 block break-all text-xs">{run.commit ?? `S3 ${run.snapshot?.versionId ?? ''}`}</span>
        </button>)}</div>
        {!!runs.data?.cursor && <Button size="sm" className="mt-3" onClick={() => setHistoryCursor(runs.data?.cursor)}>이전 빌드 보기</Button>}
        {historyCursor && <Button size="sm" className="mt-3" onClick={() => setHistoryCursor(undefined)}>최근 빌드 보기</Button>}
      </Card>
      {selectedRun && <Card title="빌드 상태·출처·로그">
        <ErrorBox error={detail.error} />
        {detail.data && <>
          <div className="flex flex-wrap items-center gap-3"><StatusPill status={detail.data.state} />
            <span className="text-xs">{detail.data.phase} {detail.data.buildStatus && `· CodeBuild ${detail.data.buildStatus}`}</span>
            {canBuild && (admin || canRegister || detail.data.actor === me.data?.subject) && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.data.state) &&
              <Button variant="danger" size="sm" disabled={busy || detail.data.cancelRequested} onClick={() => void cancelSource(detail.data!)}>빌드 취소</Button>}
          </div>
          {detail.data.cancelRequested && <p className="mt-2 text-sm">취소 요청 기록이 있습니다. 최종 상태는 실제 작업 종료 결과입니다.</p>}
          {detail.data.errorCode && <p role="status" className="mt-3 text-sm">진단: {detail.data.errorCode}</p>}
          {detail.data.state === 'START_UNCERTAIN' && <p className="mt-2 text-sm">시작 응답을 확인하지 못했습니다. 중복 실행을 막기 위해 새 빌드를 자동으로 시작하지 않습니다. 등록된 작업의 실행 기록 확인이 필요합니다.</p>}
          {canRegister && detail.data.state === 'START_UNCERTAIN' && <div className="mt-3 flex flex-wrap gap-2">
            <input aria-label="복구할 CodeBuild 실행 ID" value={recoveryId} onChange={event => setRecoveryId(event.target.value)}
              placeholder={`${detail.data.codeBuildProjectName}:실행-ID`} className="min-w-80 flex-1 rounded border border-border bg-bg px-3 py-2 text-xs" />
            <Button size="sm" disabled={!recoveryId || busy} onClick={() => void recoverSource()}>동일 요청 실행 확인</Button>
          </div>}
          {detail.data.provenance && <dl className="mt-4 space-y-2 break-all text-xs">
            <dt className="text-fg-muted">검증한 결과 이미지</dt><dd className="font-mono">{detail.data.provenance.output.resolvedImage}</dd>
            <dt className="text-fg-muted">소스 archive SHA256</dt><dd>{detail.data.provenance.sourceArchiveSha256}</dd>
            <dt className="text-fg-muted">Dockerfile SHA256</dt><dd>{detail.data.provenance.dockerfileSha256}</dd>
            <dt className="text-fg-muted">실행 환경</dt><dd>모델·워크플로 실행은 검증하지 않았습니다. 외부 의존성의 동일한 재해석도 보장하지 않습니다.</dd>
          </dl>}
          {admin && detail.data.state === 'SUCCEEDED' && detail.data.provenance && <LinkButton className="mt-3" size="sm"
            href={`/image-profiles?${new URLSearchParams({ sourceBuildId: detail.data.id, image: detail.data.provenance.output.resolvedImage })}`}>
            소스 계보를 연결해 이미지 승인 검토
          </LinkButton>}
          <ErrorBox error={output.error} />
          {detail.data.buildId && <pre aria-label="소스 빌드 로그" className="mt-4 max-h-96 overflow-auto rounded border border-border bg-bg p-3 text-xs">{output.data?.lines.join('\n') || '로그를 불러오는 중…'}</pre>}
          {output.data?.truncated && <p className="text-xs text-fg-muted">응답 크기 제한으로 로그 일부만 표시합니다.</p>}
        </>}
      </Card>}
    </>}
    {admin && <OperationsBuilds />}
  </div>;
}

function OperationsBuilds() {
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
    <h2 className="text-lg font-semibold">플랫폼 관리자 작업</h2>
    <p className="mb-4 text-sm text-fg-muted">Operations 작업은 프로젝트 실행 권한과 네트워크 정책을 동기화합니다.</p>
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
