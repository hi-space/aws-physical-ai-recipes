'use client';
import * as React from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { backendAvailable, backendStatus, projectQueues, type BackendRegistry, type BackendQueue } from './backend-ui';
type Role = 'viewer' | 'researcher' | 'project-admin';
interface Project { id: string; name: string; namespace: string; queue: string; backendId?: string; members: Record<string, Role>; description?: string }
interface User { username: string; subject?: string; email?: string }

export function ProjectsPage() {
  const me = useMe();
  const projects = useApi<Project[]>('/api/projects');
  const users = useApi<{ users: User[] }>(me.data?.role === 'admin' ? '/api/admin/users' : null);
  const backends = useApi<BackendRegistry>(me.data?.role === 'admin' ? '/api/backends' : null, { refetch: 15000 });
  const [backendId, setBackendId] = React.useState('default');
  const [namespace, setNamespace] = React.useState('');
  React.useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('backendId');
    if (requested && /^[a-z][a-z0-9-]{0,39}$/.test(requested)) { setBackendId(requested); setNamespace(''); }
  }, []);
  const backendReady = !backends.error && backendAvailable(backends.data, backendId);
  const queues = useApi<{ localQueues: BackendQueue[] }>(me.data?.role === 'admin' && backendReady ? `/api/queues?backendId=${encodeURIComponent(backendId)}` : null, { refetch: 15000 });
  const [selected, setSelected] = React.useState<string>();
  const [members, setMembers] = React.useState<Record<string, Role>>({});
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const project = projects.data?.find((item) => item.id === selected);
  const availableQueues = queues.error || projects.error ? [] : projectQueues(backends.data, backendId, queues.data?.localQueues, projects.data ?? []);
  const canCreate = me.data?.role === 'admin' && backendReady && !!projects.data && !projects.error && !queues.error && !queues.isFetching && availableQueues.some(queue => queue.namespace === namespace) && !busy;
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(undefined); setMessage('');
    try {
      const created = await api<Project>('/api/projects', { method: 'POST', json: { id: data.get('id'), name: data.get('name'), namespace, backendId, members: {} } });
      if (created?.id !== data.get('id') || created.namespace !== namespace || (created.backendId ?? 'default') !== backendId) throw new Error('생성 응답의 프로젝트·backend 연결을 확인하지 못했습니다. 목록을 새로고침하세요.');
      form.reset(); setNamespace(''); await projects.refetch(); setMessage('프로젝트를 만들었습니다. 구성원을 추가하면 연구를 시작할 수 있습니다.');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  async function saveMembers() {
    if (!project) return;
    setBusy(true); setError(undefined); setMessage('');
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', json: { members } });
      await projects.refetch(); setMessage('프로젝트 권한을 저장했습니다.');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="연구 프로젝트" />
    <p className="mb-5 max-w-3xl text-sm text-fg-muted">실험·데이터·작업 공간을 팀별로 관리합니다. 프로젝트에 속한 연구자는 같은 결과를 확인하고, 허용된 자원 풀에서 작업을 실행할 수 있습니다.</p>
    {message && <p role="status" className="mb-4 text-sm text-ok">{message}</p>}
    {(error || projects.error) && <ErrorBox error={error ?? projects.error} />}
    <ErrorBox error={me.error} />
    {projects.isLoading && <Spinner label="프로젝트를 불러오는 중…" />}
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Card title="프로젝트 목록">
        {!projects.data?.length && <EmptyState title="사용 가능한 프로젝트가 없습니다." hint="관리자에게 프로젝트 참여를 요청하세요." />}
        <div className="space-y-2">{projects.data?.map((item) => <button key={item.id}
          className={`w-full rounded-lg border p-4 text-left ${selected === item.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}
          onClick={() => { setSelected(item.id); setMembers(item.members); }}>
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{item.name}</span><Badge>{Object.keys(item.members).length}명</Badge></div>
          <p className="mt-1 text-xs text-fg-muted">{item.description ?? item.id}</p>
          <p className="mt-3 truncate text-xs text-fg-faint">backend: {item.backendId ?? 'default'} · 자원 풀: {item.namespace.replace('hyperpod-ns-', '')}</p>
        </button>)}</div>
      </Card>
      <Card title={project ? `${project.name} 구성원` : '프로젝트 권한'}>
        {!project ? <EmptyState title="프로젝트를 선택하세요." /> : me.data?.role !== 'admin'
          ? <p className="text-sm text-fg-muted">권한 변경은 프로젝트 관리자에게 요청하세요.</p>
          : <>
            <p className="mb-4 text-xs text-fg-muted">조회는 결과 확인, 연구자는 실행·업로드, 프로젝트 관리자는 구성원 관리를 할 수 있습니다.</p>
            <div className="space-y-3">{users.data?.users.map((user) => user.subject && <label key={user.subject} className="flex items-center justify-between gap-4 rounded border border-border bg-bg p-3">
              <span className="min-w-0 text-sm"><span className="block truncate">{user.username}</span><span className="block truncate text-xs text-fg-muted">{user.email}</span></span>
              <select aria-label={`${user.username} 프로젝트 권한`} className="rounded border border-border bg-bg-elev px-2 py-1.5 text-xs"
                value={members[user.subject] ?? ''} onChange={(event) => setMembers((current) => {
                  const next = { ...current }; if (event.target.value) next[user.subject!] = event.target.value as Role; else delete next[user.subject!]; return next;
                })}>
                <option value="">참여하지 않음</option><option value="viewer">조회</option><option value="researcher">연구자</option><option value="project-admin">프로젝트 관리자</option>
              </select>
            </label>)}</div>
            {users.error && <ErrorBox error={users.error} />}
            <Button className="mt-4" variant="primary" onClick={saveMembers} loading={busy}>권한 저장</Button>
          </>}
      </Card>
    </div>
    {me.data?.role === 'admin' && <Card title="새 프로젝트" className="mt-5" actions={<LinkButton href="/backends" size="sm">백엔드 연결 관리</LinkButton>}>
      <p className="mb-4 text-xs leading-5 text-fg-muted">생성 후 backend 연결은 변경할 수 없습니다. 다른 backend의 자원 풀을 조회하려면 왼쪽 연구 프로젝트에서 ‘전체 프로젝트 / 이전 실행’을 선택하세요.</p>
      <form onSubmit={create} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-5">
        <label className="text-xs text-fg-muted">프로젝트 이름<input name="name" required maxLength={100} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder="로봇 팔 정책 연구" /></label>
        <label className="text-xs text-fg-muted">식별자<input name="id" required pattern="[a-z][a-z0-9-]{0,39}" disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder="robot-arm" /></label>
        <label className="text-xs text-fg-muted">실행 backend<select name="backendId" value={backendId} disabled={busy || backends.isLoading || !!backends.error} required
          className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" onChange={event => { setBackendId(event.target.value); setNamespace(''); setError(undefined); setMessage(''); }}>
          <option value="default" disabled={!backends.data?.default?.configured}>default · 기본 EKS</option>
          {backends.data?.backends?.map(row => <option key={row.id} value={row.id} disabled={!backendAvailable(backends.data, row.id)}>{row.id} · {backendStatus(row.status).label}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">연구 자원 풀<select name="namespace" value={namespace} onChange={event => setNamespace(event.target.value)} disabled={busy || !backendReady || queues.isFetching || !!queues.error || !!projects.error} required className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm">
          <option value="">풀 선택</option>{availableQueues.map(queue => <option key={queue.namespace} value={queue.namespace}>{queue.namespace.replace('hyperpod-ns-', '')}</option>)}
        </select></label>
        <Button type="submit" loading={busy} disabled={!canCreate} variant="primary">프로젝트 만들기</Button>
      </form>
      <ErrorBox error={backends.error} /><ErrorBox error={queues.error} />
      {backends.isLoading && <Spinner label="Backend 상태를 확인하는 중…" />}
      {!backends.isLoading && !backends.error && !backendReady && <p className="mt-3 text-sm text-fg-muted">선택한 backend를 사용할 수 없습니다. 백엔드 연결 관리에서 UNREADY 진단과 등록 상태를 확인하세요.</p>}
      {queues.isFetching && <Spinner label="선택한 backend의 자원 풀을 조회하는 중…" />}
      {backendReady && !queues.isFetching && !queues.error && !projects.error && queues.data && availableQueues.length === 0 && <p className="mt-3 text-sm text-fg-muted">이 backend에서 새 프로젝트에 연결할 수 있는 자원 풀이 없습니다. 이미 연결된 풀, 허용 범위 및 실제 큐 설정을 확인하세요.</p>}
    </Card>}
  </>;
}
