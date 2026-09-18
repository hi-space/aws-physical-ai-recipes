'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBox, Field, Input, LinkButton, Select, Spinner, Table } from '@/components/ui';
import { useT, useFormat } from '@/lib/i18n';
import { api, useApi, useMe } from '@/lib/api-client';
import type { GateRecord, LegacyModelsResponse, LegacySource, ModelDetail, ModelEvaluation, ModelsResponse, ObjectPin, PublishedOutput, RegisteredModel, SourceLineage } from '@/server/evaluations/types';
import type { PromotionPolicy } from '@/server/evaluations/promotion-policy';

const outputKey = (value: PublishedOutput) => `${value.dataset}@${value.version}`;
const gateTone = { pass: 'ok', fail: 'err', review: 'warn' } as const;
const sourceId = (source: SourceLineage) => source.pipeline?.executionArn ?? source.workflowId ?? '';
const sourceHref = (source: SourceLineage) => source.pipeline
  ? `/pipelines/${encodeURIComponent(source.pipeline.executionArn)}` : `/workflows/${source.workflowId}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
type OutputFiles = { files: (ObjectPin & { kind: 'checkpoint' | 'evaluation' | 'artifact' })[] };

function OutputPicker({ outputs, value, onChange, label }: { outputs: PublishedOutput[]; value: string; onChange: (value: string) => void; label: string }) {
  const tc = useT('common');
  return <Field label={label} help={tc('publishedOutputHelp')}>
    <Select value={value} onChange={e => onChange(e.target.value)} required>
      <option value="">{tc('selectPublishedOutput')}</option>
      {outputs.map(output => <option key={outputKey(output)} value={outputKey(output)}>{output.dataset} · v{output.version} · {output.task}</option>)}
    </Select>
  </Field>;
}

function RegisterForm({ outputs, onRegistered }: { outputs: PublishedOutput[]; onRegistered: (model: RegisteredModel) => Promise<void> }) {
  const t = useT('models');
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
  return <Card title={t('registerTitle')} description={t('registerDesc')}>
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('registerName')}><Input value={name} onChange={e => setName(e.target.value)} required maxLength={120} placeholder={t('registerNamePlaceholder')} /></Field>
        <OutputPicker outputs={outputs} value={source} onChange={value => { setSource(value); setCheckpoint(''); }} label={t('registerOutput')} />
      </div>
      {files.isLoading && output && <Spinner label={t('registerLoadingFiles')} />}
      <ErrorBox error={files.error ?? error} />
      {files.data && <Field label={t('registerCheckpoint')} help={t('registerCheckpointHelp')}>
        <Select value={selected} onChange={e => setCheckpoint(e.target.value)} required>
          {!candidates.length && <option value="">{t('registerCheckpointNone')}</option>}
          {candidates.map(file => <option key={file.path} value={file.path}>{file.path} · {file.checksumType === 'FULL_OBJECT' ? 'SHA-256' : 'multipart checksum'}</option>)}
        </Select>
      </Field>}
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !selected || Boolean(files.error)}>{t('registerButton')}</Button>
    </form>
  </Card>;
}

function IngestForm({ model, outputs, onIngested }: { model: RegisteredModel; outputs: PublishedOutput[]; onIngested: (evaluation: ModelEvaluation) => Promise<void> }) {
  const t = useT('models');
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
    <p className="text-xs text-fg-muted">{t('ingestHint')}</p>
    <OutputPicker outputs={outputs} value={source} onChange={value => { setSource(value); setReport(''); }} label={t('ingestReport')} />
    {files.isLoading && output && <Spinner label={t('ingestLoadingFiles')} />}
    <ErrorBox error={files.error ?? error} />
    {files.data && <Field label={t('ingestReport')}>
      <Select value={selected} onChange={e => setReport(e.target.value)} required>
        {!candidates.length && <option value="">{t('ingestReportNone')}</option>}
        {candidates.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
      </Select>
    </Field>}
    <Button type="submit" loading={busy} disabled={!selected || !model.checkpoint.sha256 || Boolean(files.error)}>{t('ingestTitle')}</Button>
  </form>;
}

function ModelWorkspace({ detail, outputs, refresh }: { detail: ModelDetail; outputs: PublishedOutput[]; refresh: () => Promise<void> }) {
  const t = useT('models');
  const tc = useT('common');
  const { ago } = useFormat();
  const gateLabel = { pass: t('gateResult'), fail: t('gateFail'), review: t('gateReview') };
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
        !window.confirm(t('propagateRegistry', { id: model.qualityApproval.id }))) return;
    setError(undefined); setBusy(true);
    try {
      await api(`/api/models/${model.id}/registry-approval`, { method: 'POST', json: { gateId: model.qualityApproval.id, confirm: true } });
      await refresh();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <div className="min-w-0 space-y-4">
    <Card title={model.name} actions={<Badge tone={model.qualityApproval ? 'ok' : 'neutral'}>{model.qualityApproval ? t('modelQualityApproved') : t('modelNotApproved')}</Badge>}>
      <div className="grid gap-4 text-xs md:grid-cols-3">
        <div><p className="mb-1 text-fg-faint">{t('modelSourceExecution')}</p><Link className="break-all text-accent hover:underline" href={sourceHref(model.source)}>{sourceId(model.source)}</Link><p className="mt-1 text-fg-muted">{model.source.task}{model.source.attempt !== undefined ? ` · attempt ${model.source.attempt}` : ' · SageMaker'}</p></div>
        <div><p className="mb-1 text-fg-faint">{t('modelDataset')}</p><Link className="text-accent hover:underline" href={`/datasets/${encodeURIComponent(model.source.dataset.name)}`}>{model.source.dataset.name}</Link><p className="mt-1 font-mono">v{model.source.dataset.version}</p></div>
        <div><p className="mb-1 text-fg-faint">{t('modelCheckpoint')}</p><p className="break-all font-mono">{model.checkpoint.path}</p><p className="mt-1 text-fg-muted">{model.checkpoint.sha256 ? t('modelCheckpointVerified') : t('modelCheckpointUnverified')}</p></div>
      </div>
      <details className="mt-4 border-t border-border pt-3 text-xs">
        <summary className="cursor-pointer text-fg-muted">{t('modelLineage')}</summary>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          <dt className="text-fg-faint">{t('modelCheckpointId')}</dt><dd className="break-all font-mono">{model.checkpoint.versionId}</dd>
          <dt className="text-fg-faint">{t('modelCheckpointSha')}</dt><dd className="break-all font-mono">{model.checkpoint.sha256 ?? tc('notAvailable')}</dd>
          <dt className="text-fg-faint">{t('modelManifestSha')}</dt><dd className="break-all font-mono">{model.source.dataset.manifestHash}</dd>
          <dt className="text-fg-faint">{t('modelManifestVersionId')}</dt><dd className="break-all font-mono">{model.source.dataset.manifestVersionId}</dd>
          <dt className="text-fg-faint">{model.source.pipeline ? t('modelImageSageMaker') : t('modelImage')}</dt><dd className="break-all font-mono">{model.source.image}<CopyButton text={model.source.image} /></dd>
          {model.checkpointBundle && <><dt className="text-fg-faint">{t('modelBundleDigest')}</dt><dd className="break-all font-mono">{model.checkpointBundle.directory.digest}<p className="mt-1 font-sans text-fg-muted">{t('modelBundleCount', { count: model.checkpointBundle.directory.fileCount })} · {model.checkpointBundle.directory.algorithm}. tar.gz {model.checkpoint.sha256 ? 'separately verified' : 'not separately verified'}.</p></dd></>}
          {model.source.pipeline && <><dt className="text-fg-faint">{t('modelDefinitionSha')}</dt><dd className="break-all font-mono">{model.source.pipeline.definitionHash}</dd>
            <dt className="text-fg-faint">{t('modelSageMakerInput')}</dt><dd>{model.source.pipeline.training.inputs.map(input => <p key={input.channel} className="break-all">{input.channel}: {input.uri}</p>)}<p className="mt-1 text-warn">{t('modelPipelineInputWarning')}</p></dd></>}
          <dt className="text-fg-faint">{t('modelInputDatasets')}</dt><dd>{model.source.inputs.length ? model.source.inputs.map(input => <div key={`${input.name}:${input.version}`}><Link className="text-accent" href={`/datasets/${encodeURIComponent(input.name)}`}>{input.name}</Link> · v{input.version} · <span className="font-mono">{input.manifestHash.slice(0, 12)}…</span></div>) : t('modelInputsNone')}</dd>
          {!!model.source.upstreamTasks.length && <><dt className="text-fg-faint">{t('modelUpstreamTasks')}</dt><dd>{model.source.upstreamTasks.join(' → ')}</dd></>}
        </dl>
      </details>
      {model.qualityApproval && <div className="mt-4 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
        <p className="font-medium text-ok">{t('modelQualityApprovedText')}</p>
        <p className="mt-1 text-fg-muted">{model.qualityApproval.evaluationId} · {model.qualityApproval.policy.minimumEpisodes}+ · {percent(model.qualityApproval.policy.minimumSuccessRate)}{model.qualityApproval.policy.maximumLatencyP95Ms !== undefined ? ` · p95 ≤ ${model.qualityApproval.policy.maximumLatencyP95Ms} ms` : ''}</p>
        <p className="mt-1 text-fg-faint">{ago(model.qualityApproval.createdAt)}</p>
      </div>}
    </Card>
    {model.registryLink && <Card title={t('registryCard')}>
      <p className="break-all font-mono text-xs">{model.registryLink.arn}</p>
      <p className="mt-2 text-xs text-warn">{t('registryWarning', { status: model.registryLink.observedApprovalStatus })}</p>
      {model.registryApproval && <p role="status" className="mt-2 text-xs">
        {model.registryApproval.status === 'CONFIRMED' ? t('registryApprovalConfirmed', { time: model.registryApproval.confirmedAt })
          : model.registryApproval.status === 'PENDING' ? t('registryApprovalPending')
            : model.registryApproval.error}
      </p>}
      <Button className="mt-3" disabled={!detail.canPropagateRegistry || !model.qualityApproval || busy ||
        model.registryApproval?.status === 'CONFIRMED' && model.registryApproval.gateId === model.qualityApproval.id}
        loading={busy} onClick={() => void propagateRegistry()}>{t('registryApprovalButton')}</Button>
      <p className="mt-2 text-[11px] text-fg-faint">{t('registryApprovalNote')}</p>
    </Card>}

    <Card title={t('evaluationCard')} description={t('evaluationDesc')} actions={canWrite && model.evaluationLaunch ? <LinkButton href={model.evaluationLaunch.href} size="sm">{model.evaluationUnavailableReason ? t('evaluationLaunch') : t('evaluationLaunchNew')}</LinkButton> : undefined}>
      {model.evaluationUnavailableReason && <p className="mb-3 rounded border border-border bg-bg p-3 text-xs text-fg-muted">{t('evaluationUnavailable', { reason: model.evaluationUnavailableReason })}</p>}
      {!evaluations.length ? <EmptyState title={t('evaluationNone')} hint={t('evaluationHint')} /> : <>
        <Table className="[&_table]:min-w-[560px] [&_td]:whitespace-nowrap" head={[t('evaluationColSelect'), t('evaluationColRun'), t('evaluationColType'), t('evaluationColSuccesses'), t('evaluationColSuccessRate'), t('evaluationColP95')]}>
          {evaluations.map(item => <tr key={item.id} className={item.id === evaluation?.id ? 'bg-accent/5' : ''}>
            <td><input type="radio" name={`evaluation-${model.id}`} aria-label={t('evaluationSelectLabel', { source: sourceId(item.source) })} checked={item.id === evaluation?.id} onChange={() => { setSelectedId(item.id); setGate(undefined); }} /></td>
            <td><Link className="text-accent hover:underline" href={sourceHref(item.source)}>{sourceId(item.source)}</Link><p className="text-[11px] text-fg-faint">{item.seed !== undefined ? `seed ${item.seed} · ` : ''}{ago(item.createdAt)}</p></td>
            <td>{'smoke' in item ? `${t('evaluationTypeSmoke')} · ${item.smoke.passed ? t('evaluationTypeSmokePassed') : t('evaluationTypeSmokeFailed')}` : `${t('evaluationTypeSimulation')} · ${t('evaluationTypeSimulationClosed')}`}</td>
            <td className="font-mono">{'smoke' in item ? t('evaluationSmokeNoMetrics') : `${item.metrics.successes} / ${item.metrics.episodes}`}</td>
            <td className="font-mono">{item.successRate !== undefined ? percent(item.successRate) : tc('notAvailable')}</td><td className="font-mono">{item.metrics.latencyP95Ms !== undefined ? `${item.metrics.latencyP95Ms.toFixed(1)} ms` : tc('notAvailable')}</td>
          </tr>)}
        </Table>
        {evaluation && <details className="my-3 text-xs">
          <summary className="cursor-pointer text-fg-muted">{t('evaluationArtifacts')}</summary>
          <div className="mt-3 space-y-2">
            <a className="text-accent hover:underline" href={`/api/evaluations/${evaluation.id}/artifact?kind=report`} target="_blank" rel="noreferrer">{t('evaluationReportJson')}</a>
            {'smoke' in evaluation ? <p className="text-warn">{t('evaluationSmoke', { shape: JSON.stringify(evaluation.smoke.actionShape), finite: String(evaluation.smoke.allFinite) })}</p> : <>
              <p className="break-all font-mono text-fg-faint">{t('evaluationTask', { simulator: evaluation.simulator.name, version: evaluation.simulator.version, timeout: evaluation.timeoutCount ?? tc('notAvailable') })}</p>
              <video className="max-h-80 w-full rounded border border-border bg-black" controls preload="none" src={`/api/evaluations/${evaluation.id}/artifact?kind=video`} aria-label={t('evaluationVideoLabel')} />
              {evaluation.reportedCheckpointDigest && <p className="break-all font-mono">{t('evaluationChecksumDigest', { digest: evaluation.reportedCheckpointDigest })}</p>}
            </>}
            <p className="text-fg-faint">{t('evaluationArtifactsHint')}</p>
          </div>
        </details>}
      </>}
      {canWrite && <IngestForm model={model} outputs={outputs} onIngested={async item => { setSelectedId(item.id); setGate(undefined); await refresh(); }} />}
    </Card>

    <Card title={t('gateCard')} description={t('gateDesc')}>
      <form onSubmit={event => { event.preventDefault(); void apply(false); }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('gateMinEpisodes')}><Input type="number" min={1} max={100000} step={1} value={minimumEpisodes} onChange={e => setMinimumEpisodes(e.target.value)} required disabled={!canWrite} /></Field>
          <Field label={t('gateMinSuccess')}><Input type="number" min={0} max={100} step={0.1} value={minimumSuccess} onChange={e => setMinimumSuccess(e.target.value)} required disabled={!canWrite} /></Field>
          <Field label={t('gateMaxLatency')}><Input type="number" min={0.01} max={3600000} step="any" value={maximumLatency} onChange={e => setMaximumLatency(e.target.value)} required disabled={!canWrite} /></Field>
        </div>
        <ErrorBox error={error} />
        {currentGate && <div role="status" className="rounded border border-border bg-bg p-3 text-xs">
          <Badge tone={gateTone[currentGate.decision.status]}>{gateLabel[currentGate.decision.status]}</Badge>
          <ul className="mt-2 space-y-1 text-fg-muted">{currentGate.decision.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canWrite || !evaluation} loading={busy}>{t('gateCheckButton')}</Button>
          <Button type="button" variant="primary" disabled={!canWrite || !evaluation || currentGate?.decision.status !== 'pass' || currentGate.approved || busy} onClick={() => void apply(true)}>{t('gateApproveButton')}</Button>
        </div>
        <p className="text-[11px] text-fg-faint">{t('gateNote')}</p>
      </form>
      {!!gates.length && <details className="mt-4 border-t border-border pt-3 text-xs">
        <summary className="cursor-pointer text-fg-muted">{t('gateHistory', { count: gates.length })}</summary>
        <ol className="mt-3 space-y-3">{gates.map(item => <li key={item.id} className="border-l-2 border-border pl-3">
          <Badge tone={gateTone[item.decision.status]}>{gateLabel[item.decision.status]}{item.approved ? t('gateApprovedExplicit') : ''}</Badge>
          <p className="mt-1 text-fg-muted">{item.policy.minimumEpisodes}+ · {percent(item.policy.minimumSuccessRate)}+{item.policy.maximumLatencyP95Ms !== undefined ? ` · p95 ≤ ${item.policy.maximumLatencyP95Ms} ms` : ''}</p>
          <p className="mt-1">{item.decision.reasons.join(' ')}</p><p className="mt-1 text-fg-faint">{item.evaluationId} · {ago(item.createdAt)}</p>
        </li>)}</ol>
      </details>}
    </Card>
  </div>;
}

interface S3Entry { key: string; name: string; size?: number; isPrefix: boolean }
interface S3Listing { bucket: string; entries: S3Entry[] }
function LegacyFolder({ bucket, entry }: { bucket: string; entry: S3Entry }) {
  const t = useT('models');
  const tc = useT('common');
  const [open, setOpen] = React.useState(false);
  const listing = useApi<S3Listing>(open ? `/api/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(entry.key)}` : null);
  return <div className="space-y-2 border-b border-border py-3 last:border-0">
    <div className="flex items-center justify-between gap-2"><span className="break-all font-mono text-xs">{entry.name}</span><div className="flex items-center gap-2"><CopyButton text={`s3://${bucket}/${entry.key}`} /><Button size="sm" onClick={() => setOpen(!open)}>{open ? tc('close') : tc('view')}</Button></div></div>
    {open && <div className="rounded bg-bg p-3 text-xs"><ErrorBox error={listing.error} />{listing.isLoading && <Spinner label={tc('loadingData')} />}{listing.data?.entries.map(file => <div key={file.key} className="flex justify-between gap-2 py-1"><span className="break-all font-mono">{file.name}{file.isPrefix ? '/' : ''}</span><span>{file.size !== undefined ? `${file.size} B` : ''}</span></div>)}{listing.data?.entries.length === 0 && <p className="text-fg-faint">{t('legacyNoFiles')}</p>}</div>}
  </div>;
}
function LegacySourceView({ source }: { source: LegacySource }) {
  const t = useT('models');
  const tc = useT('common');
  if (source.status === 'error') return <ErrorBox error={new Error(source.error ?? tc('errorLoad'))} />;
  if (source.status === 'not_configured') return <p className="text-xs text-fg-muted">Not configured for this deployment.</p>;
  if (source.name === 'SageMaker artifacts' || source.name === 'EKS checkpoints') {
    const listing = source.data as S3Listing;
    return listing.entries?.length ? <>{listing.entries.map(entry => <LegacyFolder key={entry.key} bucket={listing.bucket} entry={entry} />)}</> : <p className="text-xs text-fg-muted">{t('legacyEmpty')}</p>;
  }
  if (source.name === 'SageMaker registry') {
    const packages = source.data as { ModelPackageName?: string; ModelPackageArn: string; ModelPackageVersion?: number; ModelApprovalStatus?: string; ModelPackageStatus?: string }[];
    return packages.length ? <Table head={[t('legacyModelPackage'), t('legacyVersion'), t('legacyRegistryStatus'), t('legacySmoke')]}>
      {packages.map(item => <tr key={item.ModelPackageArn}><td className="max-w-md break-all font-mono">{item.ModelPackageName ?? item.ModelPackageArn}</td><td>{item.ModelPackageVersion ?? '—'}</td><td>{item.ModelPackageStatus ?? tc('notAvailable')}</td><td><Badge>{item.ModelApprovalStatus ?? tc('notAvailable')}</Badge></td></tr>)}
    </Table> : <p className="text-xs text-fg-muted">{t('legacyEmpty')}</p>;
  }
  const models = source.data as { name: string; latest_versions?: { version: string; current_stage?: string; status?: string }[] }[];
  return models.length ? <div className="space-y-3">{models.map(model => <div key={model.name}><p className="text-sm font-medium">{model.name}</p><p className="mt-1 text-xs text-fg-muted">{model.latest_versions?.map(v => `v${v.version} · ${v.current_stage ?? tc('notAvailable')} · ${v.status ?? tc('notAvailable')}`).join(' / ') || tc('notAvailable')}</p></div>)}</div> : <p className="text-xs text-fg-muted">{t('legacyEmpty')}</p>;
}
function LegacyModels() {
  const t = useT('models');
  const result = useApi<LegacyModelsResponse>('/api/models/legacy', { refetch: 30000 });
  return <div className="space-y-4">
    <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-warn">{t('legacyHint')}</p>
    <ErrorBox error={result.error} />{result.isLoading && !result.data && <Spinner label={t('loadingModels')} />}
    {result.data?.sources.map(source => <Card key={source.name} title={source.name} actions={<Badge tone={source.status === 'error' ? 'err' : 'neutral'}>{source.status}</Badge>}><LegacySourceView source={source} /></Card>)}
  </div>;
}

export function ModelsPage() {
  const t = useT('models');
  const tc = useT('common');
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
    <PageHeader title={t('title')} description={t('description')} actions={result.data?.canWrite ? <Button onClick={() => { setRegister(!register); setView('models'); }}>{register ? t('registerFormClose') : t('registerButton')}</Button> : undefined} />
    {isAdmin && <div className="mb-4 flex gap-2 border-b border-border pb-2"><Button variant={view === 'models' ? 'secondary' : 'ghost'} onClick={() => setView('models')}>{t('projectModels')}</Button><Button variant={view === 'legacy' ? 'secondary' : 'ghost'} onClick={() => setView('legacy')}>{t('legacyModels')}</Button></div>}
    {view === 'legacy' && isAdmin ? <LegacyModels /> : <div className="space-y-4">
      <ErrorBox error={result.error} />{result.error && result.data && <p className="text-xs text-warn">{tc('errorStale')}</p>}
      {result.isLoading && !result.data && <Spinner label={t('loadingModels')} />}
      {result.data && !result.data.canWrite && <p className="text-xs text-fg-muted">{t('readOnlyHint')}</p>}
      {register && result.data?.canWrite && <RegisterForm outputs={result.data.outputs} onRegistered={async model => { setSelected(model.id); setCursor(undefined); setRegister(false); await result.refetch(); }} />}
      {result.data?.outputLimitReached && <p className="text-xs text-warn">{t('outputLimitReached')}</p>}
      {result.data && !result.data.models.length && !selectedId ? <EmptyState title={t('emptyModels')} hint={t('emptyModelsHint')} action={result.data.canWrite ? <Button variant="primary" onClick={() => setRegister(true)}>{t('emptyModelsAction')}</Button> : undefined} /> : result.data && <div className="grid items-start gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <Card title={t('modelCard')}>
          <nav aria-label={t('modelCard')} className="space-y-1">{result.data.models.map(model => <button key={model.id} onClick={() => setSelected(model.id)} aria-current={model.id === selectedId ? 'true' : undefined} className={`w-full rounded border px-3 py-3 text-left ${model.id === selectedId ? 'border-accent/50 bg-accent/5' : 'border-transparent hover:bg-bg-elev-2'}`}><span className="block truncate text-sm font-medium">{model.name}</span><span className="mt-1 block text-[11px] text-fg-muted">{model.qualityApproval ? `${t('modelQualityApproved')} · pinned criteria` : `Registered · ${t('modelNotApproved')}`}</span><span className="mt-1 block truncate text-[11px] font-mono text-fg-faint">{model.source.dataset.name} · v{model.source.dataset.version}</span></button>)}</nav>
          <div className="mt-3 flex gap-2">{cursor && <Button size="sm" onClick={() => { setCursor(undefined); setSelected(undefined); }}>{tc('back')}</Button>}{result.data.cursor && <Button size="sm" onClick={() => { setCursor(result.data!.cursor); setSelected(undefined); }}>{tc('next')}</Button>}</div>
        </Card>
        <div className="min-w-0 space-y-3"><ErrorBox error={detail.error} />{detail.error && detail.data && <p className="text-xs text-warn">{tc('errorStale')}</p>}{detail.isLoading && !detail.data && <Spinner label={t('loadingDetail')} />}{detail.data && <ModelWorkspace key={detail.data.model.id} detail={detail.data} outputs={result.data.outputs} refresh={refresh} />}</div>
      </div>}
    </div>}
  </>;
}
