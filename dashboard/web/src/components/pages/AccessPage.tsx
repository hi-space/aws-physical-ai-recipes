'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CopyButton, Dialog, EmptyState, ErrorBox, Field, Input, Select, Spinner, Table } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import type { CredentialMetadata } from '@/server/services/credentials';
import type { ApiScope, ApiTokenMetadata } from '@/server/auth/api-tokens';

interface CredentialList { projectId: string; credentials: CredentialMetadata[]; capabilities: { canWrite: boolean; canShare: boolean; canRegisterLegacy: boolean } }
interface TokenList { projectId: string; tokens: ApiTokenMetadata[]; availableScopes: ApiScope[] }
const scopeLabels: Record<ApiScope, string> = {
  'workflows:read': '워크플로 조회·로그', 'workflows:write': '워크플로 제출·취소',
  'datasets:read': '데이터셋 조회', 'datasets:write': '데이터셋 업로드·변경',
  'sessions:read': '세션 조회', 'sessions:write': '세션 생성·연결·종료',
  'models:read': '모델 조회', 'metrics:read': '지표 조회',
};

export function AccessPage() {
  const credentials = useApi<CredentialList>('/api/credentials', { refetch: 15000 });
  const tokens = useApi<TokenList>('/api/tokens', { refetch: 15000 });
  const [mode, setMode] = useState<'value' | 'legacy'>('value');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [issuedToken, setIssuedToken] = useState('');
  const [rotating, setRotating] = useState<CredentialMetadata | null>(null);
  const capabilities = credentials.data?.capabilities;
  const projectId = credentials.data?.projectId ?? tokens.data?.projectId;
  const consistentProject = !credentials.data || !tokens.data || credentials.data.projectId === tokens.data.projectId;
  // Secret values and newly issued tokens deliberately do not enter the query/mutation cache.
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await action(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  function createCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    void perform(async () => {
      const base = { name: String(fields.get('name') ?? ''), kind: String(fields.get('kind')), scope: String(fields.get('scope')) };
      try {
        await api(mode === 'legacy' ? '/api/credentials/legacy' : '/api/credentials', { method: 'POST', json: mode === 'legacy'
          ? { ...base, ref: String(fields.get('ref') ?? '') } : { ...base, value: String(fields.get('value') ?? '') } });
        form.reset(); setNotice(mode === 'legacy' ? '기존 참조를 등록했습니다. 값의 존재 여부는 실행 시 확인합니다.' : '자격증명을 저장했습니다. 값은 다시 조회할 수 없습니다.');
        await credentials.refetch();
      } finally {
        const input = form.elements.namedItem('value') as HTMLInputElement | null;
        if (input) input.value = '';
      }
    });
  }
  function createToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    void perform(async () => {
      setIssuedToken('');
      const created = await api<{ token: string; metadata: ApiTokenMetadata }>('/api/tokens', { method: 'POST', json: {
        name: String(fields.get('name')), scopes: fields.getAll('scopes').map(String), expiresInDays: Number(fields.get('days')),
      } });
      if (!created.token || !created.metadata?.id) throw new Error('토큰 발급 응답을 확인할 수 없습니다. 목록에서 상태를 확인하세요.');
      setIssuedToken(created.token); form.reset(); await tokens.refetch();
    });
  }
  function rotate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!rotating) return;
    const form = event.currentTarget; const value = String(new FormData(form).get('value') ?? ''); const id = rotating.id;
    void perform(async () => {
      try {
        await api(`/api/credentials/${id}/rotate`, { method: 'POST', json: { value } });
        setRotating(null); setNotice('자격증명 값을 교체했습니다.'); await credentials.refetch();
      } finally { form.reset(); }
    });
  }
  return (
    <>
      <PageHeader title="접근 관리" description="현재 연구 프로젝트의 자격증명과 개인 API 토큰을 관리합니다." />
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">프로젝트 선택 메뉴에서 작업할 프로젝트를 선택하세요. {projectId && <Badge>{projectId}</Badge>}</p>
        {error !== undefined && <ErrorBox error={error} />}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {!consistentProject && <ErrorBox error={{ message: '프로젝트 정보가 일치하지 않습니다. 페이지를 새로고침하세요.' }} />}
        <Card title="학습 자격증명" description="HF·NGC·일반 비밀값은 암호화 저장소에 보관합니다. 화면과 목록 API에는 참조만 표시됩니다.">
          {credentials.error && <ErrorBox error={credentials.error} />}
          {credentials.isLoading && <Spinner label="자격증명을 불러오는 중…" />}
          {credentials.data && <>
            {capabilities?.canWrite && consistentProject && !credentials.error && (
              <form onSubmit={createCredential} className="space-y-3 mb-5">
                {capabilities.canRegisterLegacy && <Field label="등록 방식"><Select value={mode} onChange={(event) => setMode(event.target.value as 'value' | 'legacy')} disabled={busy}><option value="value">새 비밀값 저장</option><option value="legacy">기존 워크숍 참조 등록</option></Select></Field>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="이름"><Input name="name" required maxLength={80} disabled={busy} /></Field>
                  <Field label="유형"><Select name="kind" disabled={busy}><option value="hf">Hugging Face</option><option value="ngc">NVIDIA NGC</option><option value="generic">일반 비밀값</option></Select></Field>
                  <Field label="사용 범위"><Select name="scope" disabled={busy}><option value="private">나만 사용</option>{capabilities.canShare && <option value="project">프로젝트에 공유</option>}</Select></Field>
                </div>
                {mode === 'legacy' ? <Field label="기존 SSM 참조" help="값을 읽거나 복사하지 않고 참조만 등록합니다."><Input name="ref" required placeholder="/groot/hf-token" disabled={busy} /></Field>
                  : <Field label="비밀값" help="저장 후에는 값을 다시 표시하지 않습니다."><Input name="value" type="password" autoComplete="new-password" required disabled={busy} /></Field>}
                <Button type="submit" loading={busy}>자격증명 등록</Button>
              </form>
            )}
            {credentials.data.credentials.length ? <Table head={['이름 / 유형', '범위', '상태', '참조', '관리']} dense>
              {credentials.data.credentials.map((credential) => {
                const editable = consistentProject && !credentials.error && capabilities?.canWrite && (credential.scope === 'private' || capabilities.canShare);
                const available = ['READY', 'REGISTERED', 'ERROR'].includes(credential.status);
                return <tr key={credential.id}>
                  <td>{credential.name} <Badge>{credential.kind}</Badge></td>
                  <td>{credential.scope === 'private' ? '비공개' : '프로젝트 공유'}</td>
                  <td><Badge tone={credential.status === 'ERROR' ? 'err' : credential.status === 'READY' ? 'ok' : 'neutral'}>{credential.status === 'REGISTERED' ? '참조 등록 (존재 미검증)' : credential.status}</Badge></td>
                  <td><code className="text-xs break-all">{credential.ref}</code><CopyButton text={credential.ref} /></td>
                  <td>{editable && <div className="flex gap-2">
                    {credential.managed && <Button size="sm" onClick={() => setRotating(credential)} disabled={busy || !available}>값 교체</Button>}
                    <Button size="sm" variant="danger" disabled={busy || !available} onClick={() => {
                      if (!confirm(credential.managed ? '자격증명과 저장된 비밀값을 삭제할까요?' : '이 참조의 등록을 해제할까요? 원본 비밀값은 유지됩니다.')) return;
                      void perform(async () => { await api(`/api/credentials/${credential.id}`, { method: 'DELETE' }); await credentials.refetch(); setNotice('자격증명 등록을 삭제했습니다.'); });
                    }}>삭제</Button>
                  </div>}</td>
                </tr>;
              })}
            </Table> : !credentials.error && <EmptyState title="등록된 자격증명이 없습니다." />}
          </>}
        </Card>
        <Card title="개인 API 토큰" description="선택한 프로젝트와 범위에서만 사용할 수 있습니다. 최대 30일이며, 현재 사용자 권한을 넘는 관리자 권한은 전달되지 않습니다.">
          {tokens.error && <ErrorBox error={tokens.error} />}
          {tokens.isLoading && <Spinner label="토큰을 불러오는 중…" />}
          {tokens.data && <>
            {!tokens.error && consistentProject && <form onSubmit={createToken} className="space-y-3 mb-5">
              <div className="grid gap-3 sm:grid-cols-2"><Field label="토큰 이름"><Input name="name" required maxLength={80} disabled={busy} /></Field><Field label="만료 (일)"><Input name="days" type="number" min={1} max={30} step={1} defaultValue={7} required disabled={busy} /></Field></div>
              <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="text-xs mb-2">허용할 API 범위 (한 개 이상 선택)</legend>{tokens.data.availableScopes.map((scope) => <label key={scope} className="text-xs flex gap-2"><input type="checkbox" name="scopes" value={scope} defaultChecked={scope === 'workflows:read'} disabled={busy} />{scopeLabels[scope]} <code>{scope}</code></label>)}</fieldset>
              <Button type="submit" loading={busy}>토큰 발급</Button>
            </form>}
            {issuedToken && <div role="status" className="rounded border border-accent p-3 mb-4 space-y-2">
              <p className="text-sm">이 토큰은 지금 한 번만 표시됩니다. CLI 로그인 입력에 사용하거나 안전한 장소에 보관하세요.</p>
              <div className="flex gap-2"><Input type="password" readOnly value={issuedToken} aria-label="새 API 토큰" /><CopyButton text={issuedToken} /></div>
              <Button size="sm" variant="ghost" onClick={() => setIssuedToken('')}>복사 완료 · 토큰 숨기기</Button>
            </div>}
            {tokens.data.tokens.length ? <Table head={['이름', '허용 범위', '만료', '상태', '관리']} dense>{tokens.data.tokens.map((token) => <tr key={token.id}>
              <td>{token.name}</td><td className="text-xs">{token.scopes.join(', ')}</td><td className="text-xs">{token.expiresAt}</td><td>{token.revokedAt ? '폐기됨' : Date.parse(token.expiresAt) <= Date.now() ? '만료' : '사용 가능'}</td>
              <td>{!token.revokedAt && <Button size="sm" variant="danger" disabled={busy || !!tokens.error || !consistentProject} onClick={() => { if (!confirm('이 토큰을 즉시 폐기할까요?')) return; void perform(async () => { await api(`/api/tokens/${token.id}`, { method: 'DELETE' }); setIssuedToken(''); await tokens.refetch(); setNotice('토큰을 폐기했습니다.'); }); }}>폐기</Button>}</td>
            </tr>)}</Table> : !tokens.error && <EmptyState title="발급한 API 토큰이 없습니다." />}
          </>}
        </Card>
        <Card title="CLI 연결"><p className="text-sm">CLI에서 아래 명령을 실행하고 토큰 입력 요청이 나타나면 붙여넣으세요. 명령줄 인자로 토큰을 전달하지 마세요.</p><code className="block text-xs mt-2">python3 dashboard/cli/pai.py login --url https://대시보드주소</code><p className="text-xs text-fg-muted mt-2">API 또는 세션 연결이 준비되지 않으면 CLI는 오류를 반환합니다.</p></Card>
      </div>
      <Dialog open={!!rotating} onClose={() => !busy && setRotating(null)} title="자격증명 값 교체">
        <form onSubmit={rotate} className="space-y-3"><Field label="새 비밀값"><Input name="value" type="password" required autoComplete="new-password" disabled={busy} /></Field><Button type="submit" loading={busy}>교체</Button></form>
      </Dialog>
    </>
  );
}
