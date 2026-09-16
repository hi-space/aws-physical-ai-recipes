'use client';
import { useState } from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner, Table } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { backendStatus, registrationBody, type BackendRegistry, type BackendRevision, type BackendRow } from './backend-ui';

export function BackendsPage() {
  const me = useMe(), admin = me.data?.role === 'admin';
  const registry = useApi<BackendRegistry>(admin ? '/api/backends' : null, { refetch: 15000 });
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const current = registry.data?.backends?.find(row => row.id === selected);
  const detail = useApi<{ backend: BackendRow; revisions: BackendRevision[] }>(admin && current ? `/api/backends/${encodeURIComponent(current.id)}` : null);
  const registered = typeof current?.version === 'number' && current.version > 0;
  const canRegister = !!current?.profile && Number.isSafeInteger(current.version) && current.version! >= 0;
  async function change(action: 'register' | 'toggle' | 'check') {
    if (!admin || !current || busy || registry.error || !canRegister) return;
    setBusy(true); setError(undefined); setNotice('');
    try {
      const saved = action === 'check'
        ? await api<BackendRow>(`/api/backends/${encodeURIComponent(current.id)}/check`, { method: 'POST', json: { version: current.version } })
        : await api<BackendRow>('/api/backends', { method: 'POST', json: registrationBody(current, action === 'toggle' ? !current.enabled : true) });
      if (saved?.id !== current.id || !Number.isSafeInteger(saved.version) || saved.version! < 1 || !['READY', 'UNREADY', 'DISABLED'].includes(saved.status)) throw new Error('응답의 backend 식별자·버전·상태를 확인하지 못했습니다. 목록을 새로고침하세요.');
      const refreshed = await registry.refetch(); await detail.refetch();
      if (refreshed.error) throw new Error('요청은 처리되었지만 현재 상태를 다시 읽지 못했습니다. 목록을 새로고침하세요.');
      setNotice(`${current.id} v${saved.version} · ${action === 'check' ? '검사 완료' : '등록 기록 저장'} · ${backendStatus(saved.status).label}`);
    } catch (cause) {
      setError(cause);
      // CAS conflicts can change the next usable version. Refresh without retrying the mutation.
      await registry.refetch();
    } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader title="백엔드 연결" description="등록된 EKS 실행 환경의 상태와 진단을 확인하고 프로젝트에 연결합니다."
      actions={admin ? <LinkButton href="/projects">프로젝트 관리</LinkButton> : undefined} />
    <ErrorBox error={me.error} />
    {me.isLoading && <Spinner label="관리자 권한을 확인하는 중…" />}
    {me.data && !admin && <EmptyState title="플랫폼 관리자 전용 화면입니다." hint="프로젝트 관리자를 통한 구성원 권한과는 별개입니다." />}
    {admin && <>
      <ErrorBox error={registry.error} /><ErrorBox error={error} />
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {registry.isLoading && <Spinner label="등록된 backend를 불러오는 중…" />}
      <Card title="기본 EKS" actions={<Button size="sm" disabled={busy || registry.isFetching} onClick={() => void registry.refetch()}>연결 목록 새로고침</Button>}>
        {registry.data?.default ? <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{registry.data.default.clusterName ?? '설정된 클러스터 없음'}</span>
          <Badge tone={registry.data.default.configured ? 'info' : 'warn'}>{registry.data.default.configured ? '기존 기본 연결 · 설정됨' : '미설정'}</Badge>
          <span className="text-xs text-fg-muted">default · 설정 여부는 추가 backend의 READY 검사 결과와 다릅니다.</span>
        </div> : <p className="text-sm text-fg-muted">기본 연결 정보를 확인하지 못했습니다.</p>}
      </Card>
      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <Card title="추가 EKS 연결">
          {!registry.isLoading && !registry.error && registry.data?.backends?.length === 0 && <EmptyState title="추가로 허용된 backend가 없습니다." hint="기본 EKS는 계속 사용할 수 있습니다. 추가 대상은 관리자가 배포 allowlist에 설정해야 합니다." />}
          <div className="space-y-2">{registry.data?.backends?.map(row => {
            const status = backendStatus(row.status);
            return <button key={row.id} type="button" aria-pressed={selected === row.id} disabled={busy} onClick={() => { setSelected(row.id); setError(undefined); setNotice(''); }}
              className={`w-full rounded border p-3 text-left ${selected === row.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}>
              <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{row.id}</span><Badge tone={status.tone}>{status.label}</Badge></span>
              <span className="mt-2 block text-xs text-fg-muted">{row.profile?.eks.eksClusterName ?? '배포 설정 확인 필요'} · {row.version ? `등록 v${row.version}` : '미등록'}</span>
            </button>;
          })}</div>
        </Card>
        <Card title={current ? `${current.id} · 연결 정보와 진단` : '연결 정보와 진단'}>
          {!current ? <EmptyState title="추가 backend를 선택하세요." /> : <>
            <div className="mb-3 flex items-center gap-2"><Badge tone={backendStatus(current.status).tone}>{backendStatus(current.status).label}</Badge>
              <span className="text-xs text-fg-muted">등록 {current.version ? `v${current.version}` : '없음'}{current.configVersion ? ` · 배포 설정 v${current.configVersion}` : ''}</span></div>
            {current.profile && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-fg-muted">지원 범위</dt><dd>{current.profile.accountId} · {current.profile.region} · {current.profile.vpcId}</dd>
              <dt className="text-fg-muted">EKS</dt><dd className="break-all">{current.profile.eks.eksClusterName}</dd>
              <dt className="text-fg-muted">저장소</dt><dd className="break-all">{current.profile.eks.fsxFileSystemId ?? 'FSx 미확인'} · {current.profile.eks.dataBucket ?? '데이터 버킷 미확인'}</dd>
              <dt className="text-fg-muted">허용 네임스페이스</dt><dd className="break-all">{current.profile.namespaces.join(', ') || '없음'}</dd>
            </dl>}
            <ul aria-label="Backend 진단" className="mt-4 space-y-2 text-sm">{current.findings.map((finding, index) => <li key={`${finding.code}:${index}`} className="rounded border border-border p-3">
              <code className="text-xs text-fg-muted">{finding.code}</code><p className="mt-1">{finding.message}</p>
            </li>)}</ul>
            {current.status !== 'READY' && current.findings.length === 0 && <p className="mt-3 text-sm text-fg-muted">현재 사용할 수 없습니다. 등록 상태와 배포 검증 결과를 확인하세요.</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {!registered ? <Button disabled={!canRegister || busy || !!registry.error} onClick={() => void change('register')}>허용된 backend 등록</Button>
                : <>
                  <Button disabled={busy || !canRegister || !!registry.error} variant={current.enabled ? 'danger' : 'secondary'} onClick={() => void change('toggle')}>{current.enabled ? '새 실행에 사용 중지' : '다시 사용 등록'}</Button>
                  {current.findings.some(finding => finding.code === 'configuration_changed') && <Button disabled={busy || !!registry.error} onClick={() => void change('register')}>현재 배포 설정으로 새 버전 등록</Button>}
                  <Button disabled={busy || !current.enabled || !canRegister || !!registry.error} onClick={() => void change('check')}>연결·권한 다시 검사</Button>
                </>}
              {current.status === 'READY' && current.enabled && <LinkButton href={`/projects?backendId=${encodeURIComponent(current.id)}`} variant="primary">이 backend로 프로젝트 만들기</LinkButton>}
            </div>
            {busy && <Spinner label="요청을 처리하는 중…" />}
            <p className="mt-3 text-xs leading-5 text-fg-muted">등록과 다시 검사는 자원을 생성하지 않습니다. 검사 결과와 네트워크 증거는 읽기 전용이며, 이 화면에서 준비 완료로 지정할 수 없습니다.</p>
            <ErrorBox error={detail.error} />
            {!!detail.data?.revisions.length && <details className="mt-4">
              <summary className="cursor-pointer text-sm">등록 버전 이력</summary>
              <Table head={['버전', '사용 설정', '등록 시각', '등록자']} dense><>{detail.data.revisions.map(revision => <tr key={revision.version}>
                <td>v{revision.version}</td><td>{revision.enabled ? '사용 등록' : '중지'}</td><td>{revision.createdAt}</td><td>{revision.createdBy}</td>
              </tr>)}</></Table>
            </details>}
          </>}
        </Card>
      </div>
      <p className="text-xs leading-5 text-fg-muted">추가 대상은 현재 AWS 계정의 us-east-1, 확인된 동일 VPC만 지원합니다. 계정·리전·네트워크가 불명확하거나 증거가 만료되면 UNREADY로 유지됩니다. 기존 프로젝트의 backend 연결은 변경할 수 없습니다.</p>
    </>}
  </div>;
}
