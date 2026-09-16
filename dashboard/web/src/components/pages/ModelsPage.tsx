'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBox, Field, Input, LinkButton, Select, Spinner, Table } from '@/components/ui';
import { ago } from '@/lib/format';
import { api, useApi, useMe } from '@/lib/api-client';
import type { GateRecord, LegacyModelsResponse, LegacySource, ModelDetail, ModelEvaluation, ModelsResponse, ObjectPin, PublishedOutput, RegisteredModel, SourceLineage } from '@/server/evaluations/types';
import type { PromotionPolicy } from '@/server/evaluations/promotion-policy';

const outputKey = (value: PublishedOutput) => `${value.dataset}@${value.version}`;
const gateLabel = { pass: '기준 통과', fail: '기준 미달', review: '검토 필요' };
const gateTone = { pass: 'ok', fail: 'err', review: 'warn' } as const;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const sourceId = (source: SourceLineage) => source.pipeline?.executionArn ?? source.workflowId ?? '원본 실행';
const sourceHref = (source: SourceLineage) => source.pipeline
  ? `/pipelines/${encodeURIComponent(source.pipeline.executionArn)}` : `/workflows/${source.workflowId}`;
type OutputFiles = { files: (ObjectPin & { kind: 'checkpoint' | 'evaluation' | 'artifact' })[] };

function OutputPicker({ outputs, value, onChange, label }: { outputs: PublishedOutput[]; value: string; onChange: (value: string) => void; label: string }) {
  return <Field label={label} help="완료된 작업이 게시한 READY 버전만 선택할 수 있습니다.">
    <Select value={value} onChange={e => onChange(e.target.value)} required>
      <option value="">게시된 출력 선택</option>
      {outputs.map(output => <option key={outputKey(output)} value={outputKey(output)}>{output.dataset} · v{output.version} · {output.task}</option>)}
    </Select>
  </Field>;
}

function RegisterForm({ outputs, onRegistered }: { outputs: PublishedOutput[]; onRegistered: (model: RegisteredModel) => Promise<void> }) {
  const [name, setName] = React.useState('');
  const [source, setSource] = React.useState('');
  const [checkpoint, setCheckpoint] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const output = outputs.find(value => outputKey(value) === source);
  const files = useApi<OutputFiles>(output ? `/api/models/outputs/${encodeURIComponent(output.dataset)}/${output.version}` : null);
  const candidates = files.data?.files.filter(file => file.kind === 'checkpoint') ?? [];
  const selected = candidates.find(file => file.path === checkpoint)?.path ?? candidates.find(file => file.path === 'final/model.zip')?.path ?? candidates[0]?.path ?? '';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!output || !selected) return;
    setBusy(true); setError(undefined);
    try {
      const model = await api<RegisteredModel>('/api/models', { method: 'POST', json: { name, dataset: output.dataset, version: output.version, checkpointPath: selected } });
      await onRegistered(model);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title="학습 출력에서 모델 등록" description="체크포인트와 데이터 버전을 고정합니다. 등록은 품질 승인이 아닙니다.">
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="모델 이름"><Input value={name} onChange={e => setName(e.target.value)} required maxLength={120} placeholder="예: SO-101 reach 후보" /></Field>
        <OutputPicker outputs={outputs} value={source} onChange={value => { setSource(value); setCheckpoint(''); }} label="체크포인트가 포함된 출력" />
      </div>
      {files.isLoading && output && <Spinner label="게시된 파일을 확인하는 중…" />}
      <ErrorBox error={files.error ?? error} />
      {files.data && <Field label="체크포인트 파일" help="원본 실행·작업·이미지와 파일 VersionId/checksum을 함께 보존합니다.">
        <Select value={selected} onChange={e => setCheckpoint(e.target.value)} required>
          {!candidates.length && <option value="">등록할 체크포인트 파일이 없습니다.</option>}
          {candidates.map(file => <option key={file.path} value={file.path}>{file.path} · {file.checksumType === 'FULL_OBJECT' ? 'SHA-256' : 'multipart checksum'}</option>)}
        </Select>
      </Field>}
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !selected || Boolean(files.error)}>모델 등록</Button>
    </form>
  </Card>;
}

function IngestForm({ model, outputs, onIngested }: { model: RegisteredModel; outputs: PublishedOutput[]; onIngested: (evaluation: ModelEvaluation) => Promise<void> }) {
  const [source, setSource] = React.useState('');
  const [report, setReport] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const output = outputs.find(value => outputKey(value) === source);
  const files = useApi<OutputFiles>(output ? `/api/models/outputs/${encodeURIComponent(output.dataset)}/${output.version}` : null);
  const candidates = files.data?.files.filter(file => file.kind === 'evaluation') ?? [];
  const selected = candidates.find(file => file.path === report)?.path ?? candidates[0]?.path ?? '';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!output || !selected) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api<ModelEvaluation>('/api/evaluations', { method: 'POST', json: {
        modelId: model.id, dataset: output.dataset, version: output.version, reportPath: selected,
      } });
      await onIngested(result);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-3 border-t border-border pt-4">
    <p className="text-xs text-fg-muted">평가 실행이 완료되면 게시된 evaluation.json을 연결하세요. 서버가 모델 입력 버전과 체크포인트 digest를 확인합니다.</p>
    <OutputPicker outputs={outputs} value={source} onChange={value => { setSource(value); setReport(''); }} label="평가 보고서가 포함된 출력" />
    {files.isLoading && output && <Spinner label="평가 보고서 파일을 확인하는 중…" />}
    <ErrorBox error={files.error ?? error} />
    {files.data && <Field label="게시된 평가 보고서">
      <Select value={selected} onChange={e => setReport(e.target.value)} required>
        {!candidates.length && <option value="">evaluation.json 파일이 없습니다.</option>}
        {candidates.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
      </Select>
    </Field>}
    <Button type="submit" loading={busy} disabled={!selected || !model.checkpoint.sha256 || Boolean(files.error)}>평가 결과 연결</Button>
  </form>;
}

function ModelWorkspace({ detail, outputs, refresh }: { detail: ModelDetail; outputs: PublishedOutput[]; refresh: () => Promise<void> }) {
  const { model, evaluations, gates, canWrite } = detail;
  const [selectedId, setSelectedId] = React.useState('');
  const [minimumEpisodes, setMinimumEpisodes] = React.useState('20');
  const [minimumSuccess, setMinimumSuccess] = React.useState('80');
  const [maximumLatency, setMaximumLatency] = React.useState('100');
  const [gate, setGate] = React.useState<GateRecord>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const evaluation = evaluations.find(e => e.id === selectedId) ?? evaluations[0];
  const policy: PromotionPolicy = { minimumEpisodes: Number(minimumEpisodes), minimumSuccessRate: Number(minimumSuccess) / 100, maximumLatencyP95Ms: Number(maximumLatency) };
  const currentGate = gate && gate.evaluationId === evaluation?.id && JSON.stringify(gate.policy) === JSON.stringify(policy) ? gate : undefined;
  async function apply(approve: boolean) {
    if (!evaluation) return;
    setError(undefined); setBusy(true);
    try {
      const result = await api<{ gate: GateRecord }>(`/api/models/${model.id}/promotion`, { method: 'POST', json: { evaluationId: evaluation.id, policy, approve } });
      setGate(result.gate);
      await refresh();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  async function propagateRegistry() {
    if (!model.qualityApproval || !model.registryLink ||
        !window.confirm(`검증된 품질 승인 ${model.qualityApproval.id}를 연결된 SageMaker ModelPackage에 반영할까요? AWS Registry 상태가 변경됩니다.`)) return;
    setError(undefined); setBusy(true);
    try {
      await api(`/api/models/${model.id}/registry-approval`, { method: 'POST', json: { gateId: model.qualityApproval.id, confirm: true } });
      await refresh();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <div className="min-w-0 space-y-4">
    <Card title={model.name} actions={<Badge tone={model.qualityApproval ? 'ok' : 'neutral'}>{model.qualityApproval ? '애플리케이션 품질 승인' : '품질 미승인'}</Badge>}>
      <div className="grid gap-4 text-xs md:grid-cols-3">
        <div><p className="mb-1 text-fg-faint">원본 실행 / 작업</p><Link className="break-all text-accent hover:underline" href={sourceHref(model.source)}>{sourceId(model.source)}</Link><p className="mt-1 text-fg-muted">{model.source.task}{model.source.attempt !== undefined ? ` · attempt ${model.source.attempt}` : ' · SageMaker'}</p></div>
        <div><p className="mb-1 text-fg-faint">고정된 출력 버전</p><Link className="text-accent hover:underline" href={`/datasets/${encodeURIComponent(model.source.dataset.name)}`}>{model.source.dataset.name}</Link><p className="mt-1 font-mono">v{model.source.dataset.version}</p></div>
        <div><p className="mb-1 text-fg-faint">체크포인트</p><p className="break-all font-mono">{model.checkpoint.path}</p><p className="mt-1 text-fg-muted">{model.checkpoint.sha256 ? '전체 파일 SHA-256 확인' : '복합 checksum — 전체 digest 미확인'}</p></div>
      </div>
      <details className="mt-4 border-t border-border pt-3 text-xs">
        <summary className="cursor-pointer text-fg-muted">버전·이미지·데이터 계보 확인</summary>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          <dt className="text-fg-faint">체크포인트 VersionId</dt><dd className="break-all font-mono">{model.checkpoint.versionId}</dd>
          <dt className="text-fg-faint">체크포인트 SHA-256</dt><dd className="break-all font-mono">{model.checkpoint.sha256 ?? '미확인'}</dd>
          <dt className="text-fg-faint">Manifest SHA-256</dt><dd className="break-all font-mono">{model.source.dataset.manifestHash}</dd>
          <dt className="text-fg-faint">Manifest VersionId</dt><dd className="break-all font-mono">{model.source.dataset.manifestVersionId}</dd>
          <dt className="text-fg-faint">{model.source.pipeline ? 'SageMaker 선언 이미지' : '학습 이미지'}</dt><dd className="break-all font-mono">{model.source.image}<CopyButton text={model.source.image} /></dd>
          {model.checkpointBundle && <><dt className="text-fg-faint">디렉터리 묶음 digest</dt><dd className="break-all font-mono">{model.checkpointBundle.directory.digest}<p className="mt-1 font-sans text-fg-muted">{model.checkpointBundle.directory.fileCount}개 파일 · {model.checkpointBundle.directory.algorithm}. tar.gz 전체 파일 SHA-256과 별도로 검증합니다.</p></dd></>}
          {model.source.pipeline && <><dt className="text-fg-faint">파이프라인 정의 SHA-256</dt><dd className="break-all font-mono">{model.source.pipeline.definitionHash}</dd>
            <dt className="text-fg-faint">SageMaker 입력 선언</dt><dd>{model.source.pipeline.training.inputs.map(input => <p key={input.channel} className="break-all">{input.channel}: {input.uri}</p>)}<p className="mt-1 text-warn">백엔드가 선언한 URI입니다. 당시 학습 입력의 파일 버전까지 검증한 것으로 표시하지 않습니다.</p></dd></>}
          <dt className="text-fg-faint">버전이 고정된 입력 데이터셋</dt><dd>{model.source.inputs.length ? model.source.inputs.map(input => <div key={`${input.name}:${input.version}`}><Link className="text-accent" href={`/datasets/${encodeURIComponent(input.name)}`}>{input.name}</Link> · v{input.version} · <span className="font-mono">{input.manifestHash.slice(0, 12)}…</span></div>) : '고정된 입력 버전 기록 없음'}</dd>
          {!!model.source.upstreamTasks.length && <><dt className="text-fg-faint">선행 작업</dt><dd>{model.source.upstreamTasks.join(' → ')}</dd></>}
        </dl>
      </details>
      {model.qualityApproval && <div className="mt-4 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
        <p className="font-medium text-ok">이 애플리케이션에서 품질 승인됨</p>
        <p className="mt-1 text-fg-muted">근거: {model.qualityApproval.evaluationId} · 최소 {model.qualityApproval.policy.minimumEpisodes}회 / 성공률 {percent(model.qualityApproval.policy.minimumSuccessRate)}{model.qualityApproval.policy.maximumLatencyP95Ms !== undefined ? ` / p95 ${model.qualityApproval.policy.maximumLatencyP95Ms} ms 이하` : ''}</p>
        <p className="mt-1 text-fg-faint">{ago(model.qualityApproval.createdAt)} · SageMaker Registry 상태와 별도입니다.</p>
      </div>}
    </Card>
    {model.registryLink && <Card title="연결된 SageMaker ModelPackage">
      <p className="break-all font-mono text-xs">{model.registryLink.arn}</p>
      <p className="mt-2 text-xs text-warn">가져올 당시 Registry 상태: {model.registryLink.observedApprovalStatus}. 기존 smoke 승인은 로봇 작업 품질 승인이 아닙니다.</p>
      {model.registryApproval && <p role="status" className="mt-2 text-xs">
        {model.registryApproval.status === 'CONFIRMED' ? `AWS API로 품질 승인 반영 확인 · ${model.registryApproval.confirmedAt}`
          : model.registryApproval.status === 'PENDING' ? 'Registry 반영 확인 대기 — 성공으로 확정되지 않았습니다.'
            : model.registryApproval.error}
      </p>}
      <Button className="mt-3" disabled={!detail.canPropagateRegistry || !model.qualityApproval || busy ||
        model.registryApproval?.status === 'CONFIRMED' && model.registryApproval.gateId === model.qualityApproval.id}
        loading={busy} onClick={() => void propagateRegistry()}>품질 승인을 SageMaker Registry에 반영</Button>
      <p className="mt-2 text-[11px] text-fg-faint">프로젝트 관리자의 별도 동작입니다. 모델 등록·smoke 연결·기준 확인만으로 AWS 상태를 변경하지 않습니다.</p>
    </Card>}

    <Card title="검증된 평가 이력" description="게시된 실행 보고서를 서버에서 확인한 결과입니다." actions={canWrite && model.evaluationLaunch ? <LinkButton href={model.evaluationLaunch.href} size="sm">{model.evaluationUnavailableReason ? '평가 환경 검토' : '새 평가 실행'}</LinkButton> : undefined}>
      {model.evaluationUnavailableReason && <p className="mb-3 rounded border border-border bg-bg p-3 text-xs text-fg-muted">평가 실행 조건 확인 필요: {model.evaluationUnavailableReason}</p>}
      {!evaluations.length ? <EmptyState title="연결된 평가 결과가 없습니다" hint="모델을 평가한 뒤 게시된 보고서를 연결하면 실제 결과와 품질 기준을 비교할 수 있습니다." /> : <>
        <Table className="[&_table]:min-w-[560px] [&_td]:whitespace-nowrap" head={['선택', '평가 실행', '유형', '성공 / 횟수', '성공률', 'p95']}>
          {evaluations.map(item => <tr key={item.id} className={item.id === evaluation?.id ? 'bg-accent/5' : ''}>
            <td><input type="radio" name={`evaluation-${model.id}`} aria-label={`${sourceId(item.source)} 평가 선택`} checked={item.id === evaluation?.id} onChange={() => { setSelectedId(item.id); setGate(undefined); }} /></td>
            <td><Link className="text-accent hover:underline" href={sourceHref(item.source)}>{sourceId(item.source)}</Link><p className="text-[11px] text-fg-faint">{item.seed !== undefined ? `seed ${item.seed} · ` : ''}{ago(item.createdAt)}</p></td>
            <td>{'smoke' in item ? `Smoke · ${item.smoke.passed ? '형태 검사 통과' : '검사 실패'}` : '시뮬레이션 · 폐루프'}</td>
            <td className="font-mono">{'smoke' in item ? '작업 평가 없음' : `${item.metrics.successes} / ${item.metrics.episodes}`}</td>
            <td className="font-mono">{item.successRate !== undefined ? percent(item.successRate) : '해당 없음'}</td><td className="font-mono">{item.metrics.latencyP95Ms !== undefined ? `${item.metrics.latencyP95Ms.toFixed(1)} ms` : '미측정'}</td>
          </tr>)}
        </Table>
        {evaluation && <details className="my-3 text-xs">
          <summary className="cursor-pointer text-fg-muted">선택한 평가의 보고서·영상</summary>
          <div className="mt-3 space-y-2">
            <a className="text-accent hover:underline" href={`/api/evaluations/${evaluation.id}/artifact?kind=report`} target="_blank" rel="noreferrer">고정된 evaluation.json 열기</a>
            {'smoke' in evaluation ? <p className="text-warn">출력 shape {JSON.stringify(evaluation.smoke.actionShape)} · finite {String(evaluation.smoke.allFinite)}. 폐루프 성공률·영상 증거는 없습니다.</p> : <>
              <p className="break-all font-mono text-fg-faint">{evaluation.task} · {evaluation.simulator.name} {evaluation.simulator.version} · timeout {evaluation.timeoutCount ?? '미기록'}</p>
              <video className="max-h-80 w-full rounded border border-border bg-black" controls preload="none" src={`/api/evaluations/${evaluation.id}/artifact?kind=video`} aria-label="첫 평가 에피소드 영상" />
              {evaluation.reportedCheckpointDigest && <p className="break-all font-mono">보고된 디렉터리 digest: {evaluation.reportedCheckpointDigest}</p>}
            </>}
            <p className="text-fg-faint">증거 파일은 게시된 S3 VersionId를 고정해 엽니다.</p>
          </div>
        </details>}
      </>}
      {canWrite && <IngestForm model={model} outputs={outputs} onIngested={async item => { setSelectedId(item.id); setGate(undefined); await refresh(); }} />}
    </Card>

    <Card title="애플리케이션 품질 기준" description="선택한 검증 결과에 기준을 적용한 후, 별도 동작으로 품질을 승인합니다.">
      <form onSubmit={event => { event.preventDefault(); void apply(false); }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="최소 평가 횟수"><Input type="number" min={1} max={100000} step={1} value={minimumEpisodes} onChange={e => setMinimumEpisodes(e.target.value)} required disabled={!canWrite} /></Field>
          <Field label="최소 성공률 (%)"><Input type="number" min={0} max={100} step={0.1} value={minimumSuccess} onChange={e => setMinimumSuccess(e.target.value)} required disabled={!canWrite} /></Field>
          <Field label="최대 p95 지연시간 (ms)"><Input type="number" min={0.01} max={3600000} step="any" value={maximumLatency} onChange={e => setMaximumLatency(e.target.value)} required disabled={!canWrite} /></Field>
        </div>
        <ErrorBox error={error} />
        {currentGate && <div role="status" className="rounded border border-border bg-bg p-3 text-xs">
          <Badge tone={gateTone[currentGate.decision.status]}>{gateLabel[currentGate.decision.status]}</Badge>
          <ul className="mt-2 space-y-1 text-fg-muted">{currentGate.decision.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canWrite || !evaluation} loading={busy}>기준 확인</Button>
          <Button type="button" variant="primary" disabled={!canWrite || !evaluation || currentGate?.decision.status !== 'pass' || currentGate.approved || busy} onClick={() => void apply(true)}>애플리케이션 품질 승인</Button>
        </div>
        <p className="text-[11px] text-fg-faint">표본 부족·지표 누락은 검토 필요로 남습니다. 이 동작은 SageMaker Model Registry를 변경하지 않습니다.</p>
      </form>
      {!!gates.length && <details className="mt-4 border-t border-border pt-3 text-xs">
        <summary className="cursor-pointer text-fg-muted">기준 판정·승인 이력 ({gates.length})</summary>
        <ol className="mt-3 space-y-3">{gates.map(item => <li key={item.id} className="border-l-2 border-border pl-3">
          <Badge tone={gateTone[item.decision.status]}>{gateLabel[item.decision.status]}{item.approved ? ' · 명시적 승인' : ''}</Badge>
          <p className="mt-1 text-fg-muted">{item.policy.minimumEpisodes}회 이상 · {percent(item.policy.minimumSuccessRate)} 이상{item.policy.maximumLatencyP95Ms !== undefined ? ` · p95 ≤ ${item.policy.maximumLatencyP95Ms} ms` : ''}</p>
          <p className="mt-1">{item.decision.reasons.join(' ')}</p><p className="mt-1 text-fg-faint">{item.evaluationId} · {ago(item.createdAt)}</p>
        </li>)}</ol>
      </details>}
    </Card>
  </div>;
}

interface S3Entry { key: string; name: string; size?: number; isPrefix: boolean }
interface S3Listing { bucket: string; entries: S3Entry[] }
function LegacyFolder({ bucket, entry }: { bucket: string; entry: S3Entry }) {
  const [open, setOpen] = React.useState(false);
  const listing = useApi<S3Listing>(open ? `/api/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(entry.key)}` : null);
  return <div className="space-y-2 border-b border-border py-3 last:border-0">
    <div className="flex items-center justify-between gap-2"><span className="break-all font-mono text-xs">{entry.name}</span><div className="flex items-center gap-2"><CopyButton text={`s3://${bucket}/${entry.key}`} /><Button size="sm" onClick={() => setOpen(!open)}>{open ? '닫기' : '파일 보기'}</Button></div></div>
    {open && <div className="rounded bg-bg p-3 text-xs"><ErrorBox error={listing.error} />{listing.isLoading && <Spinner label="파일을 불러오는 중…" />}{listing.data?.entries.map(file => <div key={file.key} className="flex justify-between gap-2 py-1"><span className="break-all font-mono">{file.name}{file.isPrefix ? '/' : ''}</span><span>{file.size !== undefined ? `${file.size} B` : ''}</span></div>)}{listing.data?.entries.length === 0 && <p className="text-fg-faint">파일 없음</p>}</div>}
  </div>;
}
function LegacySourceView({ source }: { source: LegacySource }) {
  if (source.status === 'error') return <ErrorBox error={new Error(source.error ?? '소스를 불러오지 못했습니다.')} />;
  if (source.status === 'not_configured') return <p className="text-xs text-fg-muted">연결되지 않은 소스입니다.</p>;
  if (source.name === 'SageMaker artifacts' || source.name === 'EKS checkpoints') {
    const listing = source.data as S3Listing;
    return listing.entries?.length ? <>{listing.entries.map(entry => <LegacyFolder key={entry.key} bucket={listing.bucket} entry={entry} />)}</> : <p className="text-xs text-fg-muted">등록된 파일 없음</p>;
  }
  if (source.name === 'SageMaker registry') {
    const packages = source.data as { ModelPackageName?: string; ModelPackageArn: string; ModelPackageVersion?: number; ModelApprovalStatus?: string; ModelPackageStatus?: string }[];
    return packages.length ? <Table head={['모델 패키지', '버전', 'Registry 상태', 'Smoke / Registry 승인']}>
      {packages.map(item => <tr key={item.ModelPackageArn}><td className="max-w-md break-all font-mono">{item.ModelPackageName ?? item.ModelPackageArn}</td><td>{item.ModelPackageVersion ?? '—'}</td><td>{item.ModelPackageStatus ?? '미확인'}</td><td><Badge>{item.ModelApprovalStatus ?? '미확인'}</Badge></td></tr>)}
    </Table> : <p className="text-xs text-fg-muted">등록된 패키지 없음</p>;
  }
  const models = source.data as { name: string; latest_versions?: { version: string; current_stage?: string; status?: string }[] }[];
  return models.length ? <div className="space-y-3">{models.map(model => <div key={model.name}><p className="text-sm font-medium">{model.name}</p><p className="mt-1 text-xs text-fg-muted">{model.latest_versions?.map(v => `v${v.version} · ${v.current_stage ?? 'stage 없음'} · ${v.status ?? '상태 미확인'}`).join(' / ') || '버전 없음'}</p></div>)}</div> : <p className="text-xs text-fg-muted">등록된 모델 없음</p>;
}
function LegacyModels() {
  const result = useApi<LegacyModelsResponse>('/api/models/legacy', { refetch: 30000 });
  return <div className="space-y-4">
    <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-warn">관리자 전용 기존 AWS 소스입니다. Smoke / Registry 승인은 로봇 작업 품질 승인과 별도이며, 애플리케이션의 검증된 평가로 취급하지 않습니다.</p>
    <ErrorBox error={result.error} />{result.isLoading && !result.data && <Spinner label="기존 AWS 모델 소스를 확인하는 중…" />}
    {result.data?.sources.map(source => <Card key={source.name} title={source.name} actions={<Badge tone={source.status === 'error' ? 'err' : 'neutral'}>{source.status}</Badge>}><LegacySourceView source={source} /></Card>)}
  </div>;
}

export function ModelsPage() {
  const me = useMe();
  const [view, setView] = React.useState<'models' | 'legacy'>('models');
  const [cursor, setCursor] = React.useState<string>();
  const [selected, setSelected] = React.useState<string>();
  const [register, setRegister] = React.useState(false);
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('model_id');
    if (id && /^mdl-[a-f0-9]{24}$/.test(id)) setSelected(id);
  }, []);
  const result = useApi<ModelsResponse>(`/api/models${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { refetch: 15000 });
  const selectedId = selected ?? result.data?.models[0]?.id;
  const detail = useApi<ModelDetail>(selectedId ? `/api/models/${selectedId}` : null, { refetch: 15000 });
  const isAdmin = me.data?.role === 'admin';
  const refresh = async () => { await Promise.all([result.refetch(), detail.refetch()]); };
  return <>
    <PageHeader title="모델·평가" description="학습 출력에서 모델을 등록하고, 검증된 평가 결과로 품질을 판단합니다." actions={result.data?.canWrite ? <Button onClick={() => { setRegister(!register); setView('models'); }}>{register ? '등록 폼 닫기' : '출력에서 모델 등록'}</Button> : undefined} />
    {isAdmin && <div className="mb-4 flex gap-2 border-b border-border pb-2"><Button variant={view === 'models' ? 'secondary' : 'ghost'} onClick={() => setView('models')}>프로젝트 모델</Button><Button variant={view === 'legacy' ? 'secondary' : 'ghost'} onClick={() => setView('legacy')}>기존 AWS 모델 · 관리자</Button></div>}
    {view === 'legacy' && isAdmin ? <LegacyModels /> : <div className="space-y-4">
      <ErrorBox error={result.error} />{result.error && result.data && <p className="text-xs text-warn">최신 조회에 실패해 이전 결과를 표시하고 있습니다.</p>}
      {result.isLoading && !result.data && <Spinner label="프로젝트 모델을 불러오는 중…" />}
      {result.data && !result.data.canWrite && <p className="text-xs text-fg-muted">이 프로젝트에서는 조회만 할 수 있습니다. 등록·평가 연결·승인은 연구자 권한이 필요합니다.</p>}
      {register && result.data?.canWrite && <RegisterForm outputs={result.data.outputs} onRegistered={async model => { setSelected(model.id); setCursor(undefined); setRegister(false); await result.refetch(); }} />}
      {result.data?.outputLimitReached && <p className="text-xs text-warn">출력 선택 목록은 최근 버전으로 제한됩니다. 더 오래된 버전은 해당 데이터셋의 정확한 버전으로 API에서 선택할 수 있습니다.</p>}
      {result.data && !result.data.models.length && !selectedId ? <EmptyState title="등록된 모델이 없습니다" hint="실행이 게시한 체크포인트를 등록하면 원본 데이터·이미지·평가 이력을 함께 추적할 수 있습니다." action={result.data.canWrite ? <Button variant="primary" onClick={() => setRegister(true)}>학습 출력에서 등록</Button> : undefined} /> : result.data && <div className="grid items-start gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <Card title="등록된 모델">
          <nav aria-label="모델 선택" className="space-y-1">{result.data.models.map(model => <button key={model.id} onClick={() => setSelected(model.id)} aria-current={model.id === selectedId ? 'true' : undefined} className={`w-full rounded border px-3 py-3 text-left ${model.id === selectedId ? 'border-accent/50 bg-accent/5' : 'border-transparent hover:bg-bg-elev-2'}`}><span className="block truncate text-sm font-medium">{model.name}</span><span className="mt-1 block text-[11px] text-fg-muted">{model.qualityApproval ? '품질 승인 · 고정된 기준' : '등록됨 · 품질 미승인'}</span><span className="mt-1 block truncate text-[11px] font-mono text-fg-faint">{model.source.dataset.name} · v{model.source.dataset.version}</span></button>)}</nav>
          <div className="mt-3 flex gap-2">{cursor && <Button size="sm" onClick={() => { setCursor(undefined); setSelected(undefined); }}>처음</Button>}{result.data.cursor && <Button size="sm" onClick={() => { setCursor(result.data!.cursor); setSelected(undefined); }}>다음 모델</Button>}</div>
        </Card>
        <div className="min-w-0 space-y-3"><ErrorBox error={detail.error} />{detail.error && detail.data && <p className="text-xs text-warn">상세 조회에 실패했습니다. 표시된 이력은 이전 조회 결과입니다.</p>}{detail.isLoading && !detail.data && <Spinner label="모델 계보와 평가를 불러오는 중…" />}{detail.data && <ModelWorkspace key={detail.data.model.id} detail={detail.data} outputs={result.data.outputs} refresh={refresh} />}</div>
      </div>}
    </div>}
  </>;
}
