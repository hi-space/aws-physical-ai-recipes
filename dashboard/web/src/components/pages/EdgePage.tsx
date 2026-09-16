'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBox, Field, Input, Select, Spinner, Table, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { ago } from '@/lib/format';
import type { BenchmarkEvidence, Device, DevicesService, EdgeOperation, PublicLease } from '@/server/services/devices';
import type { ModelDetail, RegisteredModel } from '@/server/evaluations/types';

type EdgeData = Awaited<ReturnType<DevicesService['list']>>;
type DeviceDetail = Awaited<ReturnType<DevicesService['get']>>;
const statusLabel = { PREPARED: '준비됨 · 전송 전', SUBMITTING: '전송 중', SUBMISSION_UNKNOWN: '결과 미확인', SUBMITTED: 'AWS 접수됨', RUNNING: '디바이스 확인 중', SUCCEEDED: '롤아웃 확인', FAILED: '실패' };
const statusTone = (status: EdgeOperation['status']) => status === 'SUCCEEDED' ? 'ok' as const : status === 'FAILED' ? 'err' as const : status === 'SUBMISSION_UNKNOWN' ? 'warn' as const : 'info' as const;
const profilesText = (d: Device) => d.profiles.map(p => `${p.name}@${p.version}`).join('\n');
function parseProfiles(value: string) {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name, version, extra] = line.split('@');
    if (!name || !version || extra) throw new Error('컴포넌트는 한 줄에 name@version 형식으로 입력하세요.');
    return { name, version };
  });
}
function Registration({ done }: { done: () => Promise<void> }) {
  const [kind, setKind] = React.useState<Device['kind']>('virtual');
  const [label, setLabel] = React.useState(''); const [target, setTarget] = React.useState('');
  const [architecture, setArchitecture] = React.useState('amd64'); const [physical, setPhysical] = React.useState(false);
  const [ack, setAck] = React.useState(false); const [profiles, setProfiles] = React.useState('');
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await api('/api/edge/devices', { method: 'POST', json: { kind, label, targetName: target, architecture,
      physical: kind === 'virtual' ? false : physical, acknowledgePhysicalRegistration: ack,
      profiles: kind === 'virtual' ? [] : parseProfiles(profiles) } }); await done(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title="프로젝트 디바이스 등록" description="프로젝트 관리자가 대상을 명시적으로 등록합니다. 등록은 하드웨어 검증이나 배포가 아닙니다.">
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="표시 이름"><Input required value={label} onChange={e => setLabel(e.target.value)} maxLength={100} /></Field>
        <Field label="대상 종류"><Select value={kind} onChange={e => setKind(e.target.value as Device['kind'])}><option value="virtual">로컬 가상 장치 · 통신 전용</option><option value="core">Greengrass Core</option><option value="thing">IoT Thing · HIL 등록</option><option value="thing-group">Thing Group · 등록된 Core 묶음</option></Select></Field>
        <Field label="Thing / Group / 가상 장치 이름" help="ARN은 입력하지 않습니다. AWS 대상은 서버가 계정·리전을 검증합니다."><Input required value={target} onChange={e => setTarget(e.target.value)} maxLength={128} /></Field>
        <Field label="아키텍처"><Select value={architecture} onChange={e => setArchitecture(e.target.value)}><option value="amd64">amd64</option><option value="arm64">arm64 / Jetson</option></Select></Field>
      </div>
      {kind !== 'virtual' && <>
        <Field label="승인할 컴포넌트 버전" help="한 줄에 component.name@2.3.4. 실제 게시된 pinned-artifact 계약 버전만 등록됩니다."><Textarea value={profiles} onChange={e => setProfiles(e.target.value)} rows={3} /></Field>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={physical} onChange={e => setPhysical(e.target.checked)} />실물 로봇·물리 장치입니다</label>
        {physical && <label className="flex items-center gap-2 text-xs text-warn"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />관리하는 물리 장치를 명시적으로 등록합니다. 물리 동작은 아직 검증되지 않았습니다.</label>}
      </>}
      <ErrorBox error={error} /><Button type="submit" variant="primary" loading={busy} disabled={!label || !target || physical && kind !== 'virtual' && !ack}>프로젝트에 등록</Button>
    </form>
  </Card>;
}
function ProfileEditor({ device, refresh }: { device: Device; refresh: () => Promise<void> }) {
  const [value, setValue] = React.useState(profilesText(device)); const [members, setMembers] = React.useState(false);
  const [promoteToCore, setPromoteToCore] = React.useState(false);
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  return <details className="mt-4 border-t border-border pt-3 text-xs"><summary className="cursor-pointer text-fg-muted">관리자 · 컴포넌트 버전 관리</summary>
    <form className="mt-3 space-y-3" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try {
      await api(`/api/edge/devices/${device.id}`, { method: 'PATCH', json: { profiles: parseProfiles(value), refreshMembers: members, promoteToCore } }); await refresh();
    } catch (err) { setError(err); } finally { setBusy(false); } }}>
      <Field label="등록된 컴포넌트 버전" help="name@version, 한 줄에 하나. 이전 버전을 남겨야 해당 버전으로 롤백할 수 있습니다."><Textarea rows={3} value={value} onChange={e => setValue(e.target.value)} disabled={device.kind === 'virtual'} /></Field>
      {device.kind === 'thing-group' && <label className="flex items-center gap-2"><input type="checkbox" checked={members} onChange={e => setMembers(e.target.checked)} />현재 Group 멤버를 재검증해 등록 목록 갱신</label>}
      {device.kind === 'thing' && <label className="flex items-center gap-2"><input type="checkbox" checked={promoteToCore} onChange={e => setPromoteToCore(e.target.checked)} />이미 온보딩된 Greengrass Core인지 확인해 등록 갱신</label>}
      <ErrorBox error={error} /><Button type="submit" size="sm" loading={busy}>버전·멤버 갱신</Button>
    </form>
  </details>;
}
function DeploymentForm({ device, models, initialModel, prepared }: { device: Device; models: RegisteredModel[]; initialModel?: string; prepared: (op: EdgeOperation) => void }) {
  const [profileId, setProfile] = React.useState(''); const [modelId, setModel] = React.useState(initialModel ?? '');
  const [name, setName] = React.useState(''); const [allowBenchmark, setAllowBenchmark] = React.useState(false);
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  React.useEffect(() => { if (initialModel) setModel(initialModel); }, [initialModel]);
  const profile = device.profiles.find(p => p.id === profileId) ?? device.profiles[0];
  const model = models.find(m => m.id === modelId);
  const inferenceAllowed = profile?.purpose !== 'inference' || !!model?.qualityApproval?.approved;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!profile) return; setBusy(true); setError(undefined);
    try { prepared(await api<EdgeOperation>('/api/edge/deployments', { method: 'POST', json: { deviceId: device.id,
      profileId: profile.id, ...(profile.purpose === 'communication' ? {} : { modelId }), name, allowUnapprovedBenchmark: allowBenchmark } })); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  if (!['core', 'thing-group'].includes(device.kind)) return <p className="text-xs text-fg-muted">이 대상은 HIL·통신 등록용입니다. 클라우드 모델 배포에는 검증된 Greengrass Core가 필요합니다.</p>;
  return <form onSubmit={submit} className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="배포 이름"><Input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="등록된 컴포넌트·버전"><Select required value={profile?.id ?? ''} onChange={e => { setProfile(e.target.value); setAllowBenchmark(false); }}>
        {!device.profiles.length && <option value="">관리자가 버전을 등록해야 합니다</option>}
        {device.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.version} · {p.purpose} · {p.architecture}</option>)}
      </Select></Field>
    </div>
    {profile && profile.purpose !== 'communication' && <Field label="등록된 모델" help="서버가 실제 modelId와 고정된 파일 버전·checksum을 재검증합니다.">
      <Select required value={modelId} onChange={e => setModel(e.target.value)}><option value="">모델 선택</option>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.qualityApproval?.approved ? '애플리케이션 품질 승인' : '품질 미승인'}</option>)}</Select>
    </Field>}
    {profile?.purpose === 'communication' && <p className="text-xs text-info">통신 전용 테스트입니다. 모델 추론·로봇 동작 결과를 만들지 않습니다.</p>}
    {profile?.purpose === 'benchmark' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allowBenchmark} onChange={e => setAllowBenchmark(e.target.checked)} />품질 미승인 모델의 성능 벤치마크를 명시적으로 허용합니다</label>}
    {!inferenceAllowed && <p className="text-xs text-warn">추론에는 선택한 체크포인트의 애플리케이션 품질 승인이 필요합니다. SageMaker smoke 승인은 이 기준을 대신하지 않습니다.</p>}
    {model && <p className="break-all font-mono text-[11px] text-fg-faint">{model.id} · {model.checkpoint.path} · VersionId {model.checkpoint.versionId}</p>}
    <ErrorBox error={error} /><Button type="submit" variant="primary" loading={busy} disabled={!name || !profile || !inferenceAllowed || profile.purpose !== 'communication' && !model}>배포 계획 준비</Button>
    <p className="text-[11px] text-fg-faint">준비 단계는 AWS에 전송하지 않습니다. 대상과 이전 구성을 확인한 뒤 별도로 전송합니다.</p>
  </form>;
}
function OperationView({ id, canWrite, refresh, select }: { id: string; canWrite: boolean; refresh: () => Promise<void>; select: (id: string) => void }) {
  const query = useApi<EdgeOperation>(`/api/edge/operations/${id}?refresh=1`, { refetch: 10000 });
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>(); const [allowBenchmark, setAllowBenchmark] = React.useState(false);
  const op = query.data;
  async function action(kind: 'submit' | 'rollback') {
    setBusy(true); setError(undefined);
    try { const result = await api<EdgeOperation>(`/api/edge/operations/${id}/${kind}`, { method: 'POST', json: kind === 'submit' ? {} : { allowUnapprovedBenchmark: allowBenchmark } }); select(result.id); await Promise.all([query.refetch(), refresh()]); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title="배포·롤백 작업" actions={op ? <Badge tone={statusTone(op.status)}>{statusLabel[op.status]}</Badge> : undefined}>
    <ErrorBox error={query.error ?? error} />{query.isLoading && !op && <Spinner label="실제 작업 상태를 확인하는 중…" />}
    {op && <div className="space-y-3">
      <p className="text-sm font-medium">{op.name}</p><p className="break-all font-mono text-[11px] text-fg-faint">{op.id} · {op.kind} · {op.checkedAt ? `최근 확인 ${ago(op.checkedAt)}` : '아직 디바이스 완료 확인 전'}</p>
      {op.error && <ErrorBox error={new Error(op.error)} />}
      <Table className="[&_table]:min-w-[640px]" head={['고정된 대상', 'AWS 배포 ID', '실행 상태', '런타임 증거']}>
        {op.targets.map(target => <tr key={target.deviceId}><td>{target.targetName}</td><td className="font-mono text-xs">{target.deploymentId ?? '미전송'}</td><td>{target.observation?.executionStatus ?? target.state}{target.error && <p className="mt-1 max-w-sm text-xs text-err">{target.error}</p>}</td><td>{target.readiness?.length ? `${target.readiness.length}개 버전·checksum 확인` : '준비 완료 증거 대기'}</td></tr>)}
      </Table>
      <details className="text-xs"><summary className="cursor-pointer text-fg-muted">이전·계획 구성과 고정된 모델 아티팩트 확인</summary><pre className="mt-2 max-h-96 overflow-auto rounded border border-border bg-bg p-3 text-[11px]">{JSON.stringify(op.targets.map(target => ({ target: target.targetName, priorCloudSnapshot: target.priorCloudSnapshot, before: target.before, after: target.after })), null, 2)}</pre></details>
      <p className="text-xs text-fg-muted">AWS 접수만으로 완료 처리하지 않습니다. 디바이스 실행·컴포넌트 상태와 고정된 런타임 준비 증거를 확인합니다. 그룹은 이 목록의 등록 Core에만 전송됩니다.</p>
      {canWrite && ['PREPARED', 'SUBMISSION_UNKNOWN'].includes(op.status) && <Button variant="primary" loading={busy} onClick={() => void action('submit')}>{op.status === 'PREPARED' ? '검토한 계획을 AWS에 전송' : '동일 작업 ID로 재시도'}</Button>}
      {canWrite && ['SUCCEEDED', 'FAILED'].includes(op.status) && <div className="space-y-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allowBenchmark} onChange={e => setAllowBenchmark(e.target.checked)} />롤백이 벤치마크를 복원할 때 미승인 모델 사용 허용</label><Button loading={busy} onClick={() => void action('rollback')}>이전 구성으로 롤백 계획 준비</Button></div>}
    </div>}
  </Card>;
}
interface LeaseSecret extends PublicLease { token: string }
function LeasePanel({ device, lease, runs, canWrite, refresh }: { device: Device; lease?: PublicLease; runs: EdgeData['runs']; canWrite: boolean; refresh: () => Promise<void> }) {
  const [runId, setRun] = React.useState(''); const [ttl, setTtl] = React.useState('300'); const [secret, setSecret] = React.useState<LeaseSecret>();
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  const key = `pai-hil:${device.projectId}:${device.id}`;
  React.useEffect(() => { try { const value = sessionStorage.getItem(key); if (value) setSecret(JSON.parse(value)); } catch { /* memory-only lease controls remain available */ } }, [key]);
  const active = lease?.state === 'ACTIVE' && lease.expiresAt > Date.now(); const owned = active && secret?.epoch === lease?.epoch && secret?.runId === lease?.runId;
  async function action(kind: 'claim' | 'renew' | 'release') {
    setBusy(true); setError(undefined);
    try {
      const response = await api<LeaseSecret>(`/api/edge/devices/${device.id}/lease${kind === 'claim' ? '' : `/${kind}`}`, { method: 'POST', json: kind === 'claim' ? { runId, ttlSeconds: Number(ttl) } : { runId: secret!.runId, epoch: secret!.epoch, token: secret!.token, ...(kind === 'renew' ? { ttlSeconds: Number(ttl) } : {}) } });
      if (kind === 'claim') { setSecret(response); try { sessionStorage.setItem(key, JSON.stringify(response)); } catch {} }
      if (kind === 'release') { setSecret(undefined); try { sessionStorage.removeItem(key); } catch {} }
      await refresh();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title="HIL 독점 lease" description="디바이스·소유자·실행·만료·fencing epoch를 결합합니다. 이 API는 로봇 명령을 보내지 않습니다.">
    {lease && <p className="mb-3 text-xs"><Badge tone={active ? 'info' : 'neutral'}>{active ? '독점 사용 중' : '만료·해제됨'}</Badge> <span className="font-mono">epoch {lease.epoch}</span> · {lease.runId} · {new Date(lease.expiresAt).toLocaleString()}<span className="mt-1 block break-all text-fg-faint">소유자 {lease.ownerSubject}</span></p>}
    {device.kind === 'thing-group' ? <p className="text-xs text-fg-muted">HIL lease는 그룹이 아닌 개별 등록 장치를 선택하세요.</p> : canWrite && <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2"><Field label="lease를 사용할 실행"><Select value={runId} onChange={e => setRun(e.target.value)}><option value="">활성 실행 선택</option>{runs.map(run => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</Select></Field><Field label="TTL (초)"><Input type="number" min={30} max={3600} value={ttl} onChange={e => setTtl(e.target.value)} /></Field></div>
      <ErrorBox error={error} /><div className="flex flex-wrap items-center gap-2"><Button loading={busy} disabled={active || !!device.activeOperationId || !runId} onClick={() => void action('claim')}>독점 lease 획득</Button><Button loading={busy} disabled={!owned} onClick={() => void action('renew')}>갱신</Button><Button loading={busy} disabled={!owned} onClick={() => void action('release')}>해제</Button>{owned && <span className="text-xs text-fg-muted">이 탭의 lease 증명 <CopyButton text={JSON.stringify({ deviceId: device.id, runId: secret!.runId, epoch: secret!.epoch, token: secret!.token, expiresAt: lease!.expiresAt })} /></span>}</div>
      <p className="text-[11px] text-fg-faint">배포와 lease는 동시에 장치를 소유할 수 없습니다. 오래된 epoch·토큰은 갱신·해제에 사용할 수 없습니다.</p>
    </div>}
  </Card>;
}
function BenchmarkPanel({ device, evidence, models, operations, canWrite, refresh }: { device: Device; evidence: BenchmarkEvidence[]; models: RegisteredModel[]; operations: EdgeOperation[]; canWrite: boolean; refresh: () => Promise<void> }) {
  const [operationId, setOperation] = React.useState(''); const [modelId, setModel] = React.useState('');
  const [payload, setPayload] = React.useState(''); const [engine, setEngine] = React.useState(''); const [platform, setPlatform] = React.useState('');
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  const choices = operations.filter(o => o.targets.some(t => t.deviceId === device.id && t.deploymentId) && (o.profile?.purpose === 'benchmark' || o.profile?.purpose === 'communication' || o.kind === 'rollback'));
  async function ingest(source: 'imported' | 'operation-artifact') {
    setBusy(true); setError(undefined);
    try { await api(`/api/edge/devices/${device.id}/benchmarks`, { method: 'POST', json: source === 'operation-artifact' ? { source, operationId } : { source, ...(modelId ? { modelId } : {}), payload, engine: { name: engine }, platform: { architecture: device.architecture, description: platform } } }); await refresh(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  const display = (n?: number) => n === undefined ? '—' : n.toFixed(2);
  return <Card title="벤치마크 증거" description="성능 수치는 로봇 작업 성공률이나 애플리케이션 품질 승인을 대신하지 않습니다.">
    {!evidence.length && <p className="mb-4 text-xs text-fg-muted">연결된 벤치마크 결과가 없습니다.</p>}
    {evidence.map(record => <section key={record.id} className="mb-5 space-y-2 border-b border-border pb-4">
      <div className="flex flex-wrap gap-2"><Badge tone={record.verification === 'imported' ? 'warn' : 'info'}>{record.verification === 'imported' ? 'Imported · 사용자 입력' : '실제 operation 아티팩트'}</Badge><Badge>{record.kind === 'communication' ? '통신 전용' : '추론 성능'}</Badge><span className="text-xs text-fg-faint">{record.identityVerified ? '모델·엔진·플랫폼 일치 확인' : '환경·모델 identity 미검증'}</span></div>
      <p className="break-all text-xs text-fg-muted">{record.modelId ?? '모델 없음'} · {String(record.engine.name ?? '엔진 미기록')} · {String(record.engine.version ?? '버전 미기록')} · {String(record.platform.architecture ?? '')}</p>
      <Table className="[&_table]:min-w-[760px] [&_td]:whitespace-nowrap" head={['모드 / 상태', '평균 ms', 'p50', 'p95', 'p99', '표준편차', 'Hz', '반복']}>
        {record.results.map(row => <tr key={row.mode}><td>{row.mode} · {row.status}{(row.error || row.reason) && <p className="text-xs text-err">{row.error ?? row.reason}</p>}</td><td>{display(row.avg_ms)}</td><td>{display(row.p50_ms)}</td><td>{display(row.p95_ms)}</td><td>{display(row.p99_ms)}</td><td>{display(row.std_ms)}</td><td>{display(row.hz)}</td><td>{row.iterations ?? '—'}</td></tr>)}
      </Table>{record.source && <details className="text-xs"><summary className="cursor-pointer text-fg-muted">아티팩트·체크포인트 provenance</summary><pre className="mt-2 overflow-auto text-[11px]">{JSON.stringify({ operationId: record.operationId, checkpointDigest: record.checkpointDigest, source: record.source }, null, 2)}</pre></details>}
    </section>)}
    {canWrite && <div className="space-y-4">
      <ErrorBox error={error} /><div className="grid items-end gap-3 md:grid-cols-[1fr_auto]"><Field label="실제 벤치마크 작업"><Select value={operationId} onChange={e => setOperation(e.target.value)}><option value="">전송한 벤치마크·통신 작업 선택</option>{choices.map(o => <option key={o.id} value={o.id}>{o.name} · {o.id}</option>)}</Select></Field><Button loading={busy} disabled={!operationId} onClick={() => void ingest('operation-artifact')}>고정된 결과 가져오기</Button></div>
      <details className="text-xs"><summary className="cursor-pointer text-fg-muted">기존 workshop JSON·로그 가져오기 (Imported)</summary><div className="mt-3 space-y-3">
        <Field label="Imported 결과의 모델 연결 (선택)"><Select value={modelId} onChange={e => setModel(e.target.value)}><option value="">모델 연결 없음</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <div className="grid gap-3 md:grid-cols-2"><Field label="사용자가 기록한 엔진"><Input value={engine} onChange={e => setEngine(e.target.value)} placeholder="pytorch / trt_dit_action_head" /></Field><Field label="사용자가 기록한 플랫폼"><Input value={platform} onChange={e => setPlatform(e.target.value)} placeholder="장치·GPU·운영체제 설명" /></Field></div>
        <Field label="Workshop benchmark JSON 또는 로그"><Textarea rows={5} value={payload} onChange={e => setPayload(e.target.value)} /></Field>
        <Button loading={busy} disabled={!payload || !engine || !platform} onClick={() => void ingest('imported')}>Imported 증거 저장</Button>
        <p className="text-fg-faint">avg_ms / p50_ms / p95_ms / p99_ms / std_ms / hz / iterations를 검증합니다. 붙여 넣은 숫자는 실제 디바이스 실행으로 승격되지 않습니다.</p>
      </div></details>
    </div>}
  </Card>;
}

export function EdgePage() { return <React.Suspense fallback={<Spinner label="디바이스를 불러오는 중…" />}><EdgeContent /></React.Suspense>; }
function EdgeContent() {
  const search = useSearchParams(); const requested = search.get('model_id') ?? search.get('modelId');
  const validModelId = requested && /^mdl-[a-f0-9]{24}$/.test(requested) ? requested : undefined;
  const selectedModel = useApi<ModelDetail>(validModelId ? `/api/models/${validModelId}` : null);
  const query = useApi<EdgeData>('/api/edge', { refetch: 10000 }); const [selected, setSelected] = React.useState('');
  const [registration, setRegistration] = React.useState(false); const [operationId, setOperation] = React.useState('');
  const id = query.data?.devices.find(d => d.id === selected)?.id ?? query.data?.devices[0]?.id;
  const detail = useApi<DeviceDetail>(id ? `/api/edge/devices/${id}` : null, { refetch: 10000 });
  const models = [...(query.data?.models ?? [])];
  if (selectedModel.data && !models.some(m => m.id === selectedModel.data!.model.id)) models.push(selectedModel.data.model);
  const refresh = async () => { await Promise.all([query.refetch(), ...(id ? [detail.refetch()] : [])]); };
  const data = query.data, current = detail.data;
  return <>
    <PageHeader title="디바이스·엣지 실행" description="등록된 프로젝트 대상, 고정된 모델 배포, 성능 증거와 HIL 독점 lease를 관리합니다." actions={data?.canRegister ? <Button onClick={() => setRegistration(!registration)}>{registration ? '등록 폼 닫기' : '프로젝트 디바이스 등록'}</Button> : undefined} />
    <div className="space-y-4">
      <ErrorBox error={query.error} />{query.isLoading && !data && <Spinner label="프로젝트 디바이스를 불러오는 중…" />}
      {requested && !validModelId && <ErrorBox error={new Error('선택한 modelId 형식이 올바르지 않습니다. 등록된 모델을 선택하세요.')} />}
      <ErrorBox error={selectedModel.error} />{search.get('modelPath') && <p className="text-xs text-warn">이전 modelPath 링크는 배포에 사용하지 않습니다. 등록된 modelId를 선택하세요.</p>}
      {data && !data.canWrite && <p className="text-xs text-fg-muted">이 프로젝트에서는 조회만 할 수 있습니다.</p>}
      {registration && data?.canRegister && <Registration done={async () => { setRegistration(false); await query.refetch(); }} />}
      {data && !data.devices.length && <EmptyState title="프로젝트에 등록된 디바이스가 없습니다" hint="프로젝트 관리자가 새 테스트 대상 또는 관리하는 물리 장치를 명시적으로 등록해야 합니다. 기존 AWS 장치를 자동 선택하거나 배포하지 않습니다." />}
      {!!data?.devices.length && <Card title="등록된 대상"><Field label="프로젝트 디바이스·그룹"><Select value={id} onChange={e => { setSelected(e.target.value); setOperation(''); }}>{data.devices.map(d => <option key={d.id} value={d.id}>{d.label} · {d.kind} · {d.architecture}</option>)}</Select></Field></Card>}
      <ErrorBox error={detail.error} />{id && detail.isLoading && !current && <Spinner label="장치 상태를 확인하는 중…" />}
      {current && data && <React.Fragment key={current.device.id}>
        <Card title={current.device.label} actions={<Badge tone={current.device.physical ? 'warn' : 'neutral'}>{current.device.physical ? '물리 장치 · 검증 미실행' : '물리 동작 미검증'}</Badge>}>
          <div className="space-y-2 text-xs"><p>{current.device.kind} · {current.device.architecture} · {current.device.targetName}</p>{current.device.targetArn && <p className="break-all font-mono text-fg-faint">{current.device.targetArn}</p>}
            {current.device.kind === 'thing-group' && <p className="text-fg-muted">등록 Core {current.device.members.length}개로 고정 확장합니다. 나중에 그룹에 추가된 미등록 장치에는 전송하지 않습니다.</p>}
            {current.sourceError && <ErrorBox error={new Error(current.sourceError)} />}
            {current.observation && <><p>Greengrass 보고 상태: <Badge tone="neutral">{current.observation.coreStatus}</Badge></p><Table head={['컴포넌트', '버전', '런타임 상태']}>
              {current.observation.installed.map(c => <tr key={c.name}><td>{c.name}</td><td className="font-mono">{c.version}</td><td>{c.state}{c.details && <p className="text-xs text-fg-muted">{c.details}</p>}</td></tr>)}</Table></>}
          </div>{data.canRegister && <ProfileEditor key={current.device.revision} device={current.device} refresh={refresh} />}
        </Card>
        {data.canWrite && <Card title="모델 배포·벤치마크 준비"><DeploymentForm device={current.device} models={models} initialModel={selectedModel.data?.model.id} prepared={op => { setOperation(op.id); void refresh(); }} /></Card>}
        <Card title="작업 이력"><Select aria-label="배포 작업 선택" value={operationId} onChange={e => setOperation(e.target.value)}><option value="">작업 선택</option>{data.operations.filter(o => o.deviceId === current.device.id || o.targets.some(t => t.deviceId === current.device.id)).map(o => <option key={o.id} value={o.id}>{o.name} · {statusLabel[o.status]}</option>)}</Select></Card>
        {operationId && <OperationView key={operationId} id={operationId} canWrite={data.canWrite} refresh={refresh} select={setOperation} />}
        <LeasePanel device={current.device} lease={current.lease} runs={data.runs} canWrite={data.canWrite} refresh={refresh} />
        <BenchmarkPanel device={current.device} evidence={current.benchmarks} models={models} operations={data.operations} canWrite={data.canWrite} refresh={refresh} />
        <p className="text-[11px] text-fg-faint">가상 통신 검증과 실제 Jetson·로봇 검증은 별도입니다. 이 화면에는 motion/control 전송 기능이 없습니다. <Link className="text-accent" href="/models">모델 품질 근거 보기</Link></p>
      </React.Fragment>}
    </div>
  </>;
}
