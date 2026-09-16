'use client';
import { useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import type { ExecutionProfile } from '@/server/services/execution-profiles';

interface Registry {
  profiles: ExecutionProfile[]; canApprove: boolean; project: { id: string; name: string };
  requiredNodeConfiguration?: { label: string; taint: string };
}
const field = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';
const fresh = { id: '', name: '', taskName: '', yaml: '', hostNetwork: false, privileged: false, runAsRoot: false, mounts: '[]', acknowledged: false };
export function ExecutionProfilesPanel() {
  const [draft, setDraft] = useState(fresh);
  const registry = useApi<Registry>(`/api/execution-profiles${draft.id ? `?id=${encodeURIComponent(draft.id)}` : ''}`);
  const [selected, setSelected] = useState<ExecutionProfile>();
  const [viewVersion, setViewVersion] = useState<number>();
  const history = useApi<ExecutionProfile>(selected && viewVersion ? `/api/execution-profiles/${selected.id}?version=${viewVersion}` : null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [notice, setNotice] = useState('');
  const shown = history.data ?? selected;
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await work(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  function choose(profile: ExecutionProfile) {
    setSelected(profile); setViewVersion(undefined);
    setDraft({ ...fresh, id: profile.id, name: profile.name, taskName: profile.approvedTask.name,
      hostNetwork: profile.policy.hostNetwork, privileged: profile.policy.privileged,
      runAsRoot: profile.policy.runAsRoot, mounts: JSON.stringify(profile.policy.mounts, null, 2) });
  }
  return <Card title="관리자 승인 특수 실행" description="장치·호스트 자원이 필요한 작업을 전용 노드와 불변 승인 버전에 연결합니다.">
    <p className="text-sm leading-6 text-fg-muted">
      일반 연구 작업은 프로젝트 격리를 사용합니다. 이 프로필은 현재 Cognito 관리자만 실행할 수 있으며,
      승인한 이미지·명령·환경·자원·데이터 버전이 달라지면 새 승인이 필요합니다.
      호스트 네트워크 작업의 터미널은 사용할 수 있지만 앱·파일 포트 연결은 제공하지 않습니다.
    </p>
    <ErrorBox error={registry.error ?? history.error ?? error} />
    {notice && <p role="status" className="mt-3 rounded border border-border p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label="특수 실행 프로필 확인 중…" />}
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {registry.data?.profiles.map(profile => <button key={profile.id} type="button" onClick={() => choose(profile)}
        className={`rounded border p-3 text-left ${selected?.id === profile.id ? 'border-accent' : 'border-border'}`}>
        <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{profile.name}</span>
          <Badge tone={profile.enabled ? 'warn' : 'neutral'}>{profile.enabled ? `승인 v${profile.version}` : '사용 중지'}</Badge></span>
        <span className="mt-2 block text-xs text-fg-muted">{profile.nodes.length}개 전용 노드 · {profile.policy.mounts.length}개 호스트 마운트</span>
      </button>)}
    </div>
    {!registry.isLoading && !registry.data?.profiles.length && <EmptyState title="승인된 특수 실행이 없습니다." hint="기본 학습·시뮬레이션 레시피에는 이 프로필이 필요하지 않습니다." />}
    {shown && <div className="mt-4 rounded border border-border p-4 text-xs">
      <label className="text-fg-muted">승인 이력
        <select aria-label="특수 실행 승인 버전" value={viewVersion ?? selected?.version} className={field} onChange={e => setViewVersion(Number(e.target.value))}>
          {Array.from({ length: Math.min(selected?.version ?? 1, 100) }, (_, index) => (selected?.version ?? 1) - index)
            .map(version => <option key={version} value={version}>v{version}</option>)}
        </select>
      </label>
      <p className="mt-3 break-all">승인 작업 SHA-256: <code>{shown.approvedTaskHash}</code></p>
      <p className="mt-1">승인자 {shown.approvedBy} · {shown.createdAt}</p>
      <p className="mt-3 text-fg-muted">새 실행의 해당 작업에 다음 참조를 선택하거나 YAML로 추가하세요.</p>
      <pre className="mt-2 overflow-auto rounded bg-bg p-3">{`executionProfile:\n  id: ${shown.id}\n  version: ${shown.version}`}</pre>
      {registry.data?.canApprove && selected?.enabled && <Button className="mt-3" size="sm" variant="danger" disabled={busy} onClick={() => void action(async () => {
        await api(`/api/execution-profiles/${selected.id}`, { method: 'DELETE', json: { expectedVersion: selected.version } });
        setSelected(undefined); setViewVersion(undefined); await registry.refetch();
        setNotice('승인을 철회했습니다. 대기 작업도 애플리케이션 시작 전에 다시 검사합니다. 이미 시작한 작업은 실행 화면에서 취소할 수 있습니다.');
      })}>승인 철회</Button>}
    </div>}
    {registry.data?.canApprove && <details className="mt-5" open={!!selected}>
      <summary className="cursor-pointer text-sm font-medium">승인 버전 작성</summary>
      <form className="mt-4 grid gap-4 md:grid-cols-3" onSubmit={event => {
        event.preventDefault(); void action(async () => {
          const profile = await api<ExecutionProfile>('/api/execution-profiles', { method: 'POST', json: {
            id: draft.id, name: draft.name, taskName: draft.taskName, yaml: draft.yaml,
            ...(selected ? { expectedVersion: selected.version } : {}),
            acknowledgeTrustBoundary: draft.acknowledged,
            policy: { hostNetwork: draft.hostNetwork, privileged: draft.privileged, runAsRoot: draft.runAsRoot, mounts: JSON.parse(draft.mounts) },
          } });
          await registry.refetch(); choose(profile); setNotice(`v${profile.version} 승인과 실제 전용 노드 UID를 저장했습니다.`);
        });
      }}>
        {(['id', 'name', 'taskName'] as const).map((key, index) => <label key={key} className="text-xs text-fg-muted">
          {['프로필 식별자', '표시 이름', 'YAML의 대상 작업 이름'][index]}
          <input className={field} required readOnly={key === 'id' && !!selected} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
        </label>)}
        <label className="text-xs text-fg-muted md:col-span-3">승인할 워크플로 YAML · 데이터셋은 숫자 버전으로 고정
          <textarea className={`${field} font-mono text-xs`} required rows={9} value={draft.yaml} onChange={e => setDraft(d => ({ ...d, yaml: e.target.value }))} />
        </label>
        {(['hostNetwork', 'privileged', 'runAsRoot'] as const).map((key, index) => <label key={key} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.checked }))} />
          {['호스트 네트워크', '특권 컨테이너', 'root 사용자'][index]}
        </label>)}
        <label className="text-xs text-fg-muted md:col-span-3">호스트 마운트 JSON
          <textarea className={`${field} font-mono text-xs`} rows={4} value={draft.mounts} onChange={e => setDraft(d => ({ ...d, mounts: e.target.value }))} />
          <span className="mt-1 block">hostPath, mountPath, type(Directory/File/Socket/CharDevice/BlockDevice), readOnly를 지정합니다. 시스템·자격증명 루트는 제외합니다.</span>
        </label>
        {registry.data.requiredNodeConfiguration && <div className="rounded border border-border p-3 text-xs md:col-span-3">
          <p>관리자가 별도로 준비한 전용 노드에서 다음 조건을 실제 조회합니다. 이 화면은 노드를 변경하지 않습니다.</p>
          <p className="mt-2 break-all font-mono">{registry.data.requiredNodeConfiguration.label}</p>
          <p className="mt-1 break-all font-mono">{registry.data.requiredNodeConfiguration.taint}</p>
        </div>}
        <label className="flex items-start gap-2 text-xs leading-5 md:col-span-3">
          <input className="mt-1" type="checkbox" required checked={draft.acknowledged} onChange={e => setDraft(d => ({ ...d, acknowledged: e.target.checked }))} />
          이 작업을 호스트 접근이 가능한 관리자 작업으로 검토했습니다. 일반 Pod 격리와 같은 보장을 가정하지 않고 전용 노드의 권한·데이터를 관리합니다.
        </label>
        <div className="flex gap-2 md:col-span-3"><Button type="submit" loading={busy} disabled={!draft.acknowledged}>검사하고 승인</Button>
          <Button type="button" variant="ghost" onClick={() => { setSelected(undefined); setViewVersion(undefined); setDraft(fresh); }}>새 프로필</Button></div>
      </form>
    </details>}
  </Card>;
}
