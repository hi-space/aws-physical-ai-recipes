'use client';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import type { ImageProfile, ImagePreflight } from '@/server/services/image-profiles';
import { ExecutionProfilesPanel } from './ExecutionProfilesPanel';

interface Registry { project: { id: string; name: string }; profiles: ImageProfile[]; capabilities: { canApprove: boolean; canSeed: boolean } }
const base = '/api/image-profiles';
const empty = { id: '', name: '', image: '', sourceBuildId: '', cpu: '1', memory: '1', gpu: '0', vram: '0', platforms: '' };
const fieldClass = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';

export function ImageProfilesPage() {
  const registry = useApi<Registry>(base);
  const [selected, setSelected] = React.useState('');
  const [version, setVersion] = React.useState<number>();
  const current = registry.data?.profiles.find(profile => profile.id === selected);
  const viewedVersion = version ?? current?.version;
  const detail = useApi<ImageProfile>(selected ? `${base}/${selected}${viewedVersion ? `?version=${viewedVersion}` : ''}` : null);
  const [draft, setDraft] = React.useState(empty);
  const [yaml, setYaml] = React.useState('');
  const [result, setResult] = React.useState<ImagePreflight>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const [notice, setNotice] = React.useState('');
  const profile = detail.data ?? current;
  const canApprove = registry.data?.capabilities.canApprove;
  React.useEffect(() => {
    const query = new URLSearchParams(window.location.search), build = query.get('sourceBuildId'), image = query.get('image');
    if (build && /^sb-[a-f0-9]{32}$/.test(build) && image && image.length <= 600) {
      setDraft({ ...empty, id: `build-${build.slice(3, 15)}`, name: '소스 빌드 이미지', image, sourceBuildId: build });
    }
  }, []);
  function choose(value: ImageProfile) {
    setSelected(value.id); setVersion(undefined);
    setDraft({ id: value.id, name: value.name, image: value.image.requestedImage, sourceBuildId: value.sourceBuild?.id ?? '', cpu: String(value.requirements.minCpu),
      memory: String(value.requirements.minMemoryMiB / 1024), gpu: String(value.requirements.minGpu),
      vram: String(value.requirements.minGpuMemoryMiB / 1024), platforms: value.requirements.platforms.join(', ') });
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await work(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function approve(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const saved = await api<ImageProfile>(base, { method: 'POST', json: {
        id: draft.id, name: draft.name, image: draft.image, ...(current ? { expectedVersion: current.version } : {}),
        ...(draft.sourceBuildId ? { sourceBuildId: draft.sourceBuildId } : {}),
        requirements: { minCpu: Number(draft.cpu), minMemoryMiB: Number(draft.memory) * 1024,
          minGpu: Number(draft.gpu), minGpuMemoryMiB: Number(draft.vram) * 1024,
          platforms: draft.platforms.split(',').map(v => v.trim()).filter(Boolean) },
      } });
      await registry.refetch(); choose(saved); setNotice(`v${saved.version} 승인 기록을 저장했습니다.`);
    });
  }
  function example() {
    if (!profile) return;
    setYaml(JSON.stringify({ workflow: { name: 'image-check', resources: { compute: {
      cpu: profile.requirements.minCpu, memory: `${profile.requirements.minMemoryMiB}Mi`, gpu: profile.requirements.minGpu,
      ...(profile.requirements.platforms[0] ? { platform: `ml.${profile.requirements.platforms[0]}` } : {}),
    } }, tasks: [{ name: 'check', resource: 'compute', image: profile.image.resolvedImage, command: ['true'] }] } }, null, 2));
    setResult(undefined);
  }
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
      <div><p className="text-xs uppercase tracking-wider text-fg-faint">IMAGE / COMPUTE CONTRACT</p>
        <h1 className="mt-1 text-2xl font-semibold">이미지 프로필</h1>
        <p className="mt-2 text-sm text-fg-muted">{registry.data?.project.name ?? '프로젝트'} · 승인 버전, 이미지 digest, 현재 노드 사양을 함께 확인합니다.</p></div>
      <Badge tone="warn">읽기 전용 사전 검사 · 실행 보장 아님</Badge>
    </header>
    <ErrorBox error={registry.error ?? error} />
    {notice && <p role="status" className="rounded border border-border bg-bg-elev p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label="프로필을 읽는 중…" />}
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <Card title="프로젝트 이미지" actions={canApprove && <Button size="sm" disabled={busy} onClick={() => { setSelected(''); setVersion(undefined); setDraft(empty); }}>새 프로필</Button>}>
        {!registry.data?.profiles.length && <EmptyState title="등록된 이미지가 없습니다." hint="관리자가 private ECR 이미지를 검사하고 자원 요구량을 승인해야 합니다." />}
        <div className="space-y-2">{registry.data?.profiles.map(value => <button type="button" key={value.id} onClick={() => choose(value)}
          className={`w-full rounded border p-3 text-left ${selected === value.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}>
          <span className="flex justify-between gap-2"><span className="font-medium">{value.name}</span>
            <Badge tone={!value.enabled ? 'neutral' : value.approved ? 'info' : 'warn'}>{!value.enabled ? '사용 중지' : value.approved ? `승인 v${value.version}` : '검사된 후보 · 승인 필요'}</Badge></span>
          <span className="mt-2 block truncate font-mono text-xs text-fg-muted">{value.image.resolvedImage}</span>
          <span className="mt-2 block text-xs text-fg-faint">{value.image.architectures.join(' / ')} · 검사 {value.image.inspectedAt}</span>
        </button>)}</div>
        {registry.data?.capabilities.canSeed && <Button className="mt-4" loading={busy} onClick={() => void action(async () => {
          const seeded = await api<{ profiles: ImageProfile[]; findings: { message: string }[] }>(`${base}/seed`, { method: 'POST', json: {} });
          await registry.refetch(); setNotice(`검사된 후보 ${seeded.profiles.length}개. ${seeded.findings.map(f => f.message).join(' ')}`);
        })}>배포 이미지 후보 검사</Button>}
        <p className="mt-3 text-xs leading-5 text-fg-muted">환경변수에 URI가 있다는 이유로 승인하지 않습니다. 후보 생성은 ECR digest/config 검사 후에만 진행하며 기존 승인 버전을 덮어쓰지 않습니다.</p>
      </Card>
      <Card title={profile ? `${profile.name} · 증거와 이력` : '검사 범위'}>
        {profile ? <>
          <label className="text-xs text-fg-muted">불변 버전<select aria-label="프로필 버전" className={fieldClass} value={version ?? current?.version} onChange={e => setVersion(Number(e.target.value))}>
            {Array.from({ length: Math.min(current?.version ?? 1, 100) }, (_, i) => (current?.version ?? 1) - i).map(v => <option key={v} value={v}>v{v}</option>)}
          </select></label>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs text-fg-muted">고정된 이미지</dt><dd className="mt-1 break-all font-mono text-xs">{profile.image.resolvedImage}</dd></div>
            <div><dt className="text-xs text-fg-muted">검사 근거</dt><dd>{profile.image.source} · {profile.image.inspectedAt}</dd></div>
            <div><dt className="text-xs text-fg-muted">최소 승인 요구량</dt><dd>{profile.requirements.minCpu} vCPU / {profile.requirements.minMemoryMiB / 1024} GiB RAM / GPU {profile.requirements.minGpu} / GPU당 {profile.requirements.minGpuMemoryMiB ? `${profile.requirements.minGpuMemoryMiB / 1024} GiB VRAM` : 'VRAM 요구량 미지정'}</dd></div>
            <div><dt className="text-xs text-fg-muted">승인자 / 등록자</dt><dd>{profile.approvedBy ?? '미승인'} / {profile.createdBy}</dd></div>
            {profile.sourceBuild && <div><dt className="text-xs text-fg-muted">검증된 소스 계보</dt>
              <dd className="mt-1 break-all font-mono text-xs">{profile.sourceBuild.provenance.sourceArchiveSha256}</dd>
              <dd className="mt-2"><LinkButton size="sm" href={`/builds?run=${profile.sourceBuild.id}`}>연결된 빌드 보기</LinkButton></dd>
              <dd className="mt-2 text-xs text-fg-muted">워크플로는 이 이미지 프로필의 불변 버전을 통해 소스·빌드·결과 digest를 추적합니다. 모델 실행 검증은 별도입니다.</dd>
            </div>}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2"><Button onClick={example}>검사용 예제 작성</Button>
            {canApprove && current?.enabled && <Button variant="danger" disabled={busy} onClick={() => void action(async () => {
              await api(`${base}/${selected}`, { method: 'DELETE' }); await registry.refetch(); await detail.refetch(); setNotice('향후 사전 검사에서 이 프로필을 사용하지 않습니다. 이력은 보존됩니다.');
            })}>프로필 사용 중지</Button>}</div>
        </> : <p className="text-sm leading-6 text-fg-muted">현재 계정의 us-east-1 private ECR만 지원합니다. 외부 레지스트리는 미러링이 필요합니다. 드라이버, 모델 접근, 실제 학습 및 동시 배치는 별도 확인 대상입니다.</p>}
        <ErrorBox error={detail.error} />
      </Card>
    </div>
    {canApprove && <Card title={selected ? '새 승인 버전 만들기' : '이미지 검사 후 승인'}>
      <p className="mb-4 text-xs text-fg-muted">아래 요구량은 관리자 선언입니다. 자동 측정이나 학습 검증을 뜻하지 않습니다. CPU/GPU 이미지 모두 digest와 config 아키텍처를 검사합니다.</p>
      <form onSubmit={approve} className="grid gap-4 md:grid-cols-4">
        {[['id', '식별자'], ['name', '이름'], ['image', 'Private ECR tag 또는 digest'], ['platforms', '허용 플랫폼 (쉼표 구분)'], ['sourceBuildId', '연결할 소스 빌드 ID (선택)'],
          ['cpu', '최소 vCPU'], ['memory', '최소 RAM (GiB)'], ['gpu', '최소 GPU 수'], ['vram', 'GPU당 최소 VRAM (GiB)']].map(([key, label]) =>
          <label key={key} className={`text-xs text-fg-muted ${key === 'image' ? 'md:col-span-2' : ''}`}>{label}
            <input className={fieldClass} required={!['platforms', 'sourceBuildId'].includes(key)} readOnly={key === 'id' && !!selected}
              type={['cpu', 'memory', 'gpu', 'vram'].includes(key) ? 'number' : 'text'} min="0" step={key === 'gpu' ? '1' : 'any'}
              value={draft[key as keyof typeof draft]} onChange={e => setDraft(value => ({ ...value, [key]: e.target.value }))} />
          </label>)}
        <div className="md:col-span-4"><Button type="submit" variant="primary" loading={busy}>검사하고 승인 버전 저장</Button></div>
      </form>
    </Card>}
    <ExecutionProfilesPanel />
    <Card title="워크플로우 사전 검사" description="이 화면은 작업을 제출하거나 자원을 변경하지 않습니다.">
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        setResult(undefined); setResult(await api<ImagePreflight>(`${base}/preflight`, { method: 'POST', json: { yaml } }));
      }); }}>
        <textarea aria-label="사전 검사 워크플로우 YAML" required maxLength={256 * 1024} rows={9} value={yaml} onChange={event => { setYaml(event.target.value); setResult(undefined); }}
          className={`${fieldClass} font-mono text-xs`} placeholder="workflow YAML 또는 JSON" />
        <Button type="submit" className="mt-3" loading={busy} disabled={!yaml.trim()}>호환성 검사</Button>
      </form>
      {result && <div className="mt-5 space-y-3" role="status">
        <div className="flex flex-wrap justify-between gap-2"><Badge tone={result.status === 'blocked' ? 'err' : 'warn'}>{result.status === 'blocked' ? '제출 전 수정 필요' : '추가 확인 필요'}</Badge>
          <span className="text-xs text-fg-muted">검사 {result.checkedAt}</span></div>
        {result.tasks.map(task => <section key={task.task} className="rounded border border-border p-3">
          <h3 className="text-sm font-semibold">{task.task} · {task.profileId ?? '승인 프로필 없음'}{task.profileVersion && ` v${task.profileVersion}`}</h3>
          <p className="mt-1 text-xs text-fg-muted">사양 호환 후보: {task.compatibleNodes.join(', ') || '확인되지 않음'} · 드라이버: {task.driver} · 모델 접근: {task.modelAccess}</p>
          <ul className="mt-2 space-y-1 text-xs">{task.findings.map((finding, i) => <li key={i} className={finding.severity === 'error' ? 'text-err' : 'text-fg-muted'}>{finding.severity} · {finding.message}</li>)}</ul>
        </section>)}
        <details><summary className="cursor-pointer text-xs text-fg-muted">고정할 이미지 digest</summary><pre className="mt-2 overflow-auto rounded bg-bg p-3 text-xs">{JSON.stringify(result.resolvedImageDigests, null, 2)}</pre></details>
      </div>}
    </Card>
  </div>;
}
