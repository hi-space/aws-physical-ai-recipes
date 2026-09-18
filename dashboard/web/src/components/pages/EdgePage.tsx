'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBox, Field, Input, Select, Spinner, Table, Textarea } from '@/components/ui';
import { api, useApi, type Me } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';
import type { BenchmarkEvidence, Device, DevicesService, EdgeOperation, PublicLease } from '@/server/services/devices';
import type { ModelDetail, RegisteredModel } from '@/server/evaluations/types';

type EdgeData = Awaited<ReturnType<DevicesService['list']>>;
type DeviceDetail = Awaited<ReturnType<DevicesService['get']>>;
const statusTone = (status: EdgeOperation['status']) => status === 'SUCCEEDED' ? 'ok' as const : status === 'FAILED' ? 'err' as const : status === 'SUBMISSION_UNKNOWN' ? 'warn' as const : 'info' as const;
const profilesText = (d: Device) => d.profiles.map(p => `${p.name}@${p.version}`).join('\n');
function parseProfiles(value: string, t: ReturnType<typeof useT<'edge'>>) {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name, version, extra] = line.split('@');
    if (!name || !version || extra) throw new Error(t('registrationErrorFormat'));
    return { name, version };
  });
}
function Registration({ done }: { done: () => Promise<void> }) {
  const t = useT('edge');
  const [kind, setKind] = React.useState<Device['kind']>('virtual');
  const [label, setLabel] = React.useState(''); const [target, setTarget] = React.useState('');
  const [architecture, setArchitecture] = React.useState('amd64'); const [physical, setPhysical] = React.useState(false);
  const [ack, setAck] = React.useState(false); const [profiles, setProfiles] = React.useState('');
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await api('/api/edge/devices', { method: 'POST', json: { kind, label, targetName: target, architecture,
      physical: kind === 'virtual' ? false : physical, acknowledgePhysicalRegistration: ack,
      profiles: kind === 'virtual' ? [] : parseProfiles(profiles, t) } }); await done(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title={t('registrationTitle')} description={t('registrationDescription')}>
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('registrationFormLabel')}><Input required value={label} onChange={e => setLabel(e.target.value)} maxLength={100} /></Field>
        <Field label={t('registrationFormLabelTarget')}><Select value={kind} onChange={e => setKind(e.target.value as Device['kind'])}><option value="virtual">{t('registrationOptionVirtual')}</option><option value="core">{t('registrationOptionCore')}</option><option value="thing">{t('registrationOptionThing')}</option><option value="thing-group">{t('registrationOptionThingGroup')}</option></Select></Field>
        <Field label={t('registrationFormLabelTargetName')} help={t('registrationFormLabelTargetNameHelp')}><Input required value={target} onChange={e => setTarget(e.target.value)} maxLength={128} /></Field>
        <Field label={t('registrationFormLabelArchitecture')}><Select value={architecture} onChange={e => setArchitecture(e.target.value)}><option value="amd64">{t('registrationFormLabelArchitectureAmd64')}</option><option value="arm64">{t('registrationFormLabelArchitectureArm64')}</option></Select></Field>
      </div>
      {kind !== 'virtual' && <>
        <Field label={t('registrationFormLabelComponentVersion')} help={t('registrationFormLabelComponentVersionHelp')}><Textarea value={profiles} onChange={e => setProfiles(e.target.value)} rows={3} /></Field>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={physical} onChange={e => setPhysical(e.target.checked)} />{t('registrationCheckboxPhysical')}</label>
        {physical && <label className="flex items-center gap-2 text-xs text-warn"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />{t('registrationCheckboxPhysicalAck')}</label>}
      </>}
      <ErrorBox error={error} /><Button type="submit" variant="primary" loading={busy} disabled={!label || !target || physical && kind !== 'virtual' && !ack}>{t('registrationButtonSubmit')}</Button>
    </form>
  </Card>;
}
function ProfileEditor({ device, refresh }: { device: Device; refresh: () => Promise<void> }) {
  const t = useT('edge');
  const [value, setValue] = React.useState(profilesText(device)); const [members, setMembers] = React.useState(false);
  const [promoteToCore, setPromoteToCore] = React.useState(false);
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>();
  return <details className="mt-4 border-t border-border pt-3 text-xs"><summary className="cursor-pointer text-fg-muted">{t('profileEditorSummary')}</summary>
    <form className="mt-3 space-y-3" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(undefined); try {
      await api(`/api/edge/devices/${device.id}`, { method: 'PATCH', json: { profiles: parseProfiles(value, t), refreshMembers: members, promoteToCore } }); await refresh();
    } catch (err) { setError(err); } finally { setBusy(false); } }}>
      <Field label={t('profileEditorLabel')} help={t('profileEditorLabelHelp')}><Textarea rows={3} value={value} onChange={e => setValue(e.target.value)} disabled={device.kind === 'virtual'} /></Field>
      {device.kind === 'thing-group' && <label className="flex items-center gap-2"><input type="checkbox" checked={members} onChange={e => setMembers(e.target.checked)} />{t('profileEditorCheckboxMembers')}</label>}
      {device.kind === 'thing' && <label className="flex items-center gap-2"><input type="checkbox" checked={promoteToCore} onChange={e => setPromoteToCore(e.target.checked)} />{t('profileEditorCheckboxPromote')}</label>}
      <ErrorBox error={error} /><Button type="submit" size="sm" loading={busy}>{t('profileEditorButtonUpdate')}</Button>
    </form>
  </details>;
}
function DeploymentForm({ device, models, initialModel, prepared }: { device: Device; models: RegisteredModel[]; initialModel?: string; prepared: (op: EdgeOperation) => void }) {
  const t = useT('edge');
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
  if (!['core', 'thing-group'].includes(device.kind)) return <p className="text-xs text-fg-muted">{t('deploymentFormErrorNotCore')}</p>;
  return <form onSubmit={submit} className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t('deploymentFormLabelName')}><Input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label={t('deploymentFormLabelProfile')}><Select required value={profile?.id ?? ''} onChange={e => { setProfile(e.target.value); setAllowBenchmark(false); }}>
        {!device.profiles.length && <option value="">{t('deploymentFormLabelProfileEmpty')}</option>}
        {device.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.version} · {p.purpose} · {p.architecture}</option>)}
      </Select></Field>
    </div>
    {profile && profile.purpose !== 'communication' && <Field label={t('deploymentFormLabelModel')} help={t('deploymentFormLabelModelHelp')}>
      <Select required value={modelId} onChange={e => setModel(e.target.value)}><option value="">{t('deploymentFormLabelModelEmpty')}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.qualityApproval?.approved ? t('qualityApproved') : t('qualityNotApproved')}</option>)}</Select>
    </Field>}
    {profile?.purpose === 'communication' && <p className="text-xs text-info">{t('deploymentFormNotice')}</p>}
    {profile?.purpose === 'benchmark' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allowBenchmark} onChange={e => setAllowBenchmark(e.target.checked)} />{t('deploymentFormLabelBenchmark')}</label>}
    {!inferenceAllowed && <p className="text-xs text-warn">{t('deploymentFormNoticeInference')}</p>}
    {model && <p className="break-all font-mono text-[11px] text-fg-faint">{model.id} · {model.checkpoint.path} · VersionId {model.checkpoint.versionId}</p>}
    <ErrorBox error={error} /><Button type="submit" variant="primary" loading={busy} disabled={!name || !profile || !inferenceAllowed || profile.purpose !== 'communication' && !model}>{t('deploymentFormButtonSubmit')}</Button>
    <p className="text-[11px] text-fg-faint">{t('deploymentFormNote')}</p>
  </form>;
}
function OperationView({ id, canWrite, refresh, select }: { id: string; canWrite: boolean; refresh: () => Promise<void>; select: (id: string) => void }) {
  const t = useT('edge');
  const { ago } = useFormat();
  const statusLabel: Record<EdgeOperation['status'], string> = { PREPARED: t('operationViewStatusPrepared'), SUBMITTING: t('operationViewStatusSubmitting'), SUBMISSION_UNKNOWN: t('operationViewStatusSubmissionUnknown'), SUBMITTED: t('operationViewStatusSubmitted'), RUNNING: t('operationViewStatusRunning'), SUCCEEDED: t('operationViewStatusSucceeded'), FAILED: t('operationViewStatusFailed') };
  const query = useApi<EdgeOperation>(`/api/edge/operations/${id}?refresh=1`, { refetch: 10000 });
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<unknown>(); const [allowBenchmark, setAllowBenchmark] = React.useState(false);
  const op = query.data;
  async function action(kind: 'submit' | 'rollback') {
    setBusy(true); setError(undefined);
    try { const result = await api<EdgeOperation>(`/api/edge/operations/${id}/${kind}`, { method: 'POST', json: kind === 'submit' ? {} : { allowUnapprovedBenchmark: allowBenchmark } }); select(result.id); await Promise.all([query.refetch(), refresh()]); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Card title={t('operationViewTitle')} actions={op ? <Badge tone={statusTone(op.status)}>{statusLabel[op.status]}</Badge> : undefined}>
    <ErrorBox error={query.error ?? error} />{query.isLoading && !op && <Spinner label={t('operationViewLoading')} />}
    {op && <div className="space-y-3">
      <p className="text-sm font-medium">{t('operationViewName', { name: op.name })}</p><p className="break-all font-mono text-[11px] text-fg-faint">{op.id} · {op.kind} · {op.checkedAt ? ago(op.checkedAt) : t('operationViewMetaUnchecked', { id: op.id, kind: op.kind })}</p>
      {op.error && <ErrorBox error={new Error(op.error)} />}
      <Table className="[&_table]:min-w-[640px]" head={[t('operationTableHead1'), t('operationTableHead2'), t('operationTableHead3'), t('operationTableHead4')]}>
        {op.targets.map(target => <tr key={target.deviceId}><td>{target.targetName}</td><td className="font-mono text-xs">{target.deploymentId ?? t('operationViewTargetNotSubmitted')}</td><td>{target.observation?.executionStatus ?? target.state}{target.error && <p className="mt-1 max-w-sm text-xs text-err">{target.error}</p>}</td><td>{target.readiness?.length ? t('operationViewTargetReadiness', { count: target.readiness.length }) : t('operationViewTargetReadinessEmpty')}</td></tr>)}
      </Table>
      <details className="text-xs"><summary className="cursor-pointer text-fg-muted">{t('operationViewDetailsLabel')}</summary><pre className="mt-2 max-h-96 overflow-auto rounded border border-border bg-bg p-3 text-[11px]">{JSON.stringify(op.targets.map(target => ({ target: target.targetName, priorCloudSnapshot: target.priorCloudSnapshot, before: target.before, after: target.after })), null, 2)}</pre></details>
      <p className="text-xs text-fg-muted">{t('operationViewNote')}</p>
      {canWrite && ['PREPARED', 'SUBMISSION_UNKNOWN'].includes(op.status) && <Button variant="primary" loading={busy} onClick={() => void action('submit')}>{op.status === 'PREPARED' ? t('operationViewButtonSubmit') : t('operationViewButtonRetry')}</Button>}
      {canWrite && ['SUCCEEDED', 'FAILED'].includes(op.status) && <div className="space-y-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allowBenchmark} onChange={e => setAllowBenchmark(e.target.checked)} />{t('operationViewCheckboxBenchmark')}</label><Button loading={busy} onClick={() => void action('rollback')}>{t('operationViewButtonRollback')}</Button></div>}
    </div>}
  </Card>;
}
interface LeaseSecret extends PublicLease { token: string }
function LeasePanel({ device, lease, runs, canWrite, refresh }: { device: Device; lease?: PublicLease; runs: EdgeData['runs']; canWrite: boolean; refresh: () => Promise<void> }) {
  const t = useT('edge');
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
  return <Card title={t('leasePanelTitle')} description={t('leasePanelDescription')}>
    {lease && <p className="mb-3 text-xs"><Badge tone={active ? 'info' : 'neutral'}>{active ? t('leaseStatusActive') : t('leaseStatusInactive')}</Badge> <span className="font-mono">{t('leaseEpoch', { epoch: lease.epoch })}</span> · {lease.runId} · {new Date(lease.expiresAt).toLocaleString()}<span className="mt-1 block break-all text-fg-faint">{t('leaseOwner', { subject: lease.ownerSubject })}</span></p>}
    {device.kind === 'thing-group' ? <p className="text-xs text-fg-muted">{t('leaseErrorThingGroup')}</p> : canWrite && <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2"><Field label={t('leaseLabelExecution')}><Select value={runId} onChange={e => setRun(e.target.value)}><option value="">{t('selectActiveExecution')}</option>{runs.map(run => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</Select></Field><Field label={t('leaseLabelTtl')}><Input type="number" min={30} max={3600} value={ttl} onChange={e => setTtl(e.target.value)} /></Field></div>
      <ErrorBox error={error} /><div className="flex flex-wrap items-center gap-2"><Button loading={busy} disabled={active || !!device.activeOperationId || !runId} onClick={() => void action('claim')}>{t('leaseButtonClaim')}</Button><Button loading={busy} disabled={!owned} onClick={() => void action('renew')}>{t('leaseButtonRenew')}</Button><Button loading={busy} disabled={!owned} onClick={() => void action('release')}>{t('leaseButtonRelease')}</Button>{owned && <span className="text-xs text-fg-muted">{t('leaseButtonClaimProof')} <CopyButton text={JSON.stringify({ deviceId: device.id, runId: secret!.runId, epoch: secret!.epoch, token: secret!.token, expiresAt: lease!.expiresAt })} /></span>}</div>
      <p className="text-[11px] text-fg-faint">{t('leaseNote')}</p>
    </div>}
  </Card>;
}
function BenchmarkPanel({ device, evidence, models, operations, canWrite, refresh }: { device: Device; evidence: BenchmarkEvidence[]; models: RegisteredModel[]; operations: EdgeOperation[]; canWrite: boolean; refresh: () => Promise<void> }) {
  const t = useT('edge');
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
  return <Card title={t('benchmarkPanelTitle')} description={t('benchmarkPanelDescription')}>
    {!evidence.length && <p className="mb-4 text-xs text-fg-muted">{t('benchmarkEmpty')}</p>}
    {evidence.map(record => <section key={record.id} className="mb-5 space-y-2 border-b border-border pb-4">
      <div className="flex flex-wrap gap-2"><Badge tone={record.verification === 'imported' ? 'warn' : 'info'}>{record.verification === 'imported' ? t('benchmarkBadgeImported') : t('benchmarkBadgeOperation')}</Badge><Badge>{record.kind === 'communication' ? t('benchmarkBadgeCommunication') : t('benchmarkBadgeInference')}</Badge><span className="text-xs text-fg-faint">{record.identityVerified ? t('benchmarkVerified') : t('benchmarkUnverified')}</span></div>
      <p className="break-all text-xs text-fg-muted">{record.modelId ?? t('noModel')} · {String(record.engine.name ?? t('engineNotRecorded'))} · {String(record.engine.version ?? t('versionNotRecorded'))} · {String(record.platform.architecture ?? '')}</p>
      <Table className="[&_table]:min-w-[760px] [&_td]:whitespace-nowrap" head={[t('benchmarkTableHead1'), t('benchmarkTableHead2'), t('benchmarkTableHead3'), t('benchmarkTableHead4'), t('benchmarkTableHead5'), t('benchmarkTableHead6'), t('benchmarkTableHead7'), t('benchmarkTableHead8')]}>
        {record.results.map(row => <tr key={row.mode}><td>{row.mode} · {row.status}{(row.error || row.reason) && <p className="text-xs text-err">{row.error ?? row.reason}</p>}</td><td>{display(row.avg_ms)}</td><td>{display(row.p50_ms)}</td><td>{display(row.p95_ms)}</td><td>{display(row.p99_ms)}</td><td>{display(row.std_ms)}</td><td>{display(row.hz)}</td><td>{row.iterations ?? '—'}</td></tr>)}
      </Table>{record.source && <details className="text-xs"><summary className="cursor-pointer text-fg-muted">{t('benchmarkDetailsLabel')}</summary><pre className="mt-2 overflow-auto text-[11px]">{JSON.stringify({ operationId: record.operationId, checkpointDigest: record.checkpointDigest, source: record.source }, null, 2)}</pre></details>}
    </section>)}
    {canWrite && <div className="space-y-4">
      <ErrorBox error={error} /><div className="grid items-end gap-3 md:grid-cols-[1fr_auto]"><Field label={t('benchmarkOperationLabel')}><Select value={operationId} onChange={e => setOperation(e.target.value)}><option value="">{t('benchmarkOperationEmpty')}</option>{choices.map(o => <option key={o.id} value={o.id}>{o.name} · {o.id}</option>)}</Select></Field><Button loading={busy} disabled={!operationId} onClick={() => void ingest('operation-artifact')}>{t('benchmarkButtonImportArtifact')}</Button></div>
      <details className="text-xs"><summary className="cursor-pointer text-fg-muted">{t('benchmarkImportedLabel')}</summary><div className="mt-3 space-y-3">
        <Field label={t('benchmarkImportedModelLabel')}><Select value={modelId} onChange={e => setModel(e.target.value)}><option value="">{t('benchmarkImportedModelEmpty')}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <div className="grid gap-3 md:grid-cols-2"><Field label={t('benchmarkImportedEngineLabel')}><Input value={engine} onChange={e => setEngine(e.target.value)} placeholder={t('benchmarkImportedEnginePlaceholder')} /></Field><Field label={t('benchmarkImportedPlatformLabel')}><Input value={platform} onChange={e => setPlatform(e.target.value)} placeholder={t('benchmarkImportedPlatformPlaceholder')} /></Field></div>
        <Field label={t('benchmarkImportedPayloadLabel')}><Textarea rows={5} value={payload} onChange={e => setPayload(e.target.value)} /></Field>
        <Button loading={busy} disabled={!payload || !engine || !platform} onClick={() => void ingest('imported')}>{t('benchmarkButtonImportPayload')}</Button>
        <p className="text-fg-faint">{t('benchmarkImportedNote')}</p>
      </div></details>
    </div>}
  </Card>;
}

export function EdgePage() {
  const t = useT('edge');
  return <React.Suspense fallback={<Spinner label={t('loadingDevices')} />}><EdgeContent /></React.Suspense>;
}
function EdgeContent() {
  const t = useT('edge');
  const tr = useT('resources');
  const tc = useT('common');
  const me = useApi<Me>('/api/me');
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
  const statusLabel: Record<EdgeOperation['status'], string> = { PREPARED: t('operationViewStatusPrepared'), SUBMITTING: t('operationViewStatusSubmitting'), SUBMISSION_UNKNOWN: t('operationViewStatusSubmissionUnknown'), SUBMITTED: t('operationViewStatusSubmitted'), RUNNING: t('operationViewStatusRunning'), SUCCEEDED: t('operationViewStatusSucceeded'), FAILED: t('operationViewStatusFailed') };
  const res = me.data?.resources;
  return <>
    <PageHeader title={t('title')} description={t('description')} actions={data?.canRegister ? <Button onClick={() => setRegistration(!registration)}>{registration ? t('closingRegistrationForm') : t('registrationTitle')}</Button> : undefined} />
    <ResourceStrip
      source={t('resourceSource')}
      items={[
        { label: tr('thingGroup'), value: res?.edge?.thingGroup, console: res?.edge?.thingGroup ? { kind: 'iot-thing-group', name: res.edge.thingGroup } : undefined },
        { label: tr('component'), value: res?.edge?.inferenceComponent },
      ]}
    />
    <div className="space-y-4">
      <ErrorBox error={query.error} />{query.isLoading && !data && <Spinner label={t('loadingDevices')} />}
      {requested && !validModelId && <ErrorBox error={new Error(t('invalidModelId'))} />}
      <ErrorBox error={selectedModel.error} />{search.get('modelPath') && <p className="text-xs text-warn">{t('previousModelPathWarning')}</p>}
      {data && !data.canWrite && <p className="text-xs text-fg-muted">{t('viewOnly')}</p>}
      {registration && data?.canRegister && <Registration done={async () => { setRegistration(false); await query.refetch(); }} />}
      {data && !data.devices.length && <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />}
      {!!data?.devices.length && <Card title={t('deviceSelectionCard')}><Field label={t('deviceSelectionLabel')}><Select value={id} onChange={e => { setSelected(e.target.value); setOperation(''); }}>{data.devices.map(d => <option key={d.id} value={d.id}>{d.label} · {d.kind} · {d.architecture}</option>)}</Select></Field></Card>}
      <ErrorBox error={detail.error} />{id && detail.isLoading && !current && <Spinner label={t('loadingDeviceDetail')} />}
      {current && data && <React.Fragment key={current.device.id}>
        <Card title={current.device.label} actions={<Badge tone={current.device.physical ? 'warn' : 'neutral'}>{current.device.physical ? t('deviceDetailPhysicalWarning') : t('deviceDetailPhysicalOk')}</Badge>}>
          <div className="space-y-2 text-xs"><p>{t('deviceDetailKind', { kind: current.device.kind, architecture: current.device.architecture, targetName: current.device.targetName })}</p>{current.device.targetArn && <p className="break-all font-mono text-fg-faint">{t('deviceDetailTargetArn', { targetArn: current.device.targetArn })}</p>}
            {current.device.kind === 'thing-group' && <p className="text-fg-muted">{t('deviceDetailThingGroupNote', { count: current.device.members.length })}</p>}
            {current.sourceError && <ErrorBox error={new Error(current.sourceError)} />}
            {current.observation && <><p>{t('coreStatus')}: <Badge tone="neutral">{current.observation.coreStatus}</Badge></p><Table head={[t('componentTableHead1'), t('componentTableHead2'), t('componentTableHead3')]}>
              {current.observation.installed.map(c => <tr key={c.name}><td>{c.name}</td><td className="font-mono">{c.version}</td><td>{c.state}{c.details && <p className="text-xs text-fg-muted">{c.details}</p>}</td></tr>)}</Table></>}
          </div>{data.canRegister && <ProfileEditor key={current.device.revision} device={current.device} refresh={refresh} />}
        </Card>
        {data.canWrite && <Card title={t('deploymentAndBenchmark')}><DeploymentForm device={current.device} models={models} initialModel={selectedModel.data?.model.id} prepared={op => { setOperation(op.id); void refresh(); }} /></Card>}
        <Card title={t('operationHistory')}><Select aria-label={t('selectOperationDeployment')} value={operationId} onChange={e => setOperation(e.target.value)}><option value="">{t('selectOperation')}</option>{data.operations.filter(o => o.deviceId === current.device.id || o.targets.some(t => t.deviceId === current.device.id)).map(o => <option key={o.id} value={o.id}>{o.name} · {statusLabel[o.status]}</option>)}</Select></Card>
        {operationId && <OperationView key={operationId} id={operationId} canWrite={data.canWrite} refresh={refresh} select={setOperation} />}
        <LeasePanel device={current.device} lease={current.lease} runs={data.runs} canWrite={data.canWrite} refresh={refresh} />
        <BenchmarkPanel device={current.device} evidence={current.benchmarks} models={models} operations={data.operations} canWrite={data.canWrite} refresh={refresh} />
        <p className="text-[11px] text-fg-faint">{t('footer')} <Link className="text-accent" href="/models">{t('modelDetailPageLink')}</Link></p>
      </React.Fragment>}
    </div>
  </>;
}
