'use client';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Button, Card, ErrorBox, EmptyState, LinkButton, StatusPill } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import type { SourceBuildView, SourceRegistrationView } from '@/server/services/source-builds';

export function BuildsPage() {
  const t = useT('builds');
  const tc = useT('common');
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
      setNotice(t('registrationSuccess'));
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
      request.current = undefined; setNotice(t('buildSubmitted'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function cancelSource(run: SourceBuildView) {
    setBusy(true); setError(undefined);
    try { await api(`/api/builds/runs/${encodeURIComponent(run.id)}`, { method: 'POST', headers, json: { action: 'cancel' } });
      await detail.refetch(); await runs.refetch(); setNotice(t('cancelRequested'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function recoverSource() {
    if (!canRegister || busy || !selectedRun) return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/builds/runs/${encodeURIComponent(selectedRun)}/recover`, { method: 'POST', headers, json: { buildId: recoveryId } });
      await detail.refetch(); await runs.refetch(); setRecoveryId(''); setNotice(t('recoverySuccess'));
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')} />
    <ErrorBox error={me.error ?? error ?? catalog.error ?? runs.error} />
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!scope ? <EmptyState title={tc('select')} hint={t('sourcesCard')} /> : <>
      <Card title={`${project?.name ?? scope} · ${t('sourcesCard')}`}>
        {!catalog.isLoading && !catalog.error && !catalog.data?.targets.length && <EmptyState title={t('noTargets')}
          hint={t('noTargetsHint')} />}
        {canRegister && !!catalog.data?.targets.length && <div className="mb-5 flex flex-wrap gap-3">
          <select aria-label={t('selectTarget')} value={targetId} onChange={event => setTargetId(event.target.value)}
            className="rounded border border-border bg-bg px-3 py-2 text-sm">
            <option value="">{t('selectTarget')}</option>{catalog.data.targets.map(target =>
              <option key={target.id} value={target.id}>{target.id} · {target.sourceType}</option>)}
          </select>
          <input aria-label={t('sourceName')} value={name} maxLength={80} onChange={event => setName(event.target.value)}
            className="rounded border border-border bg-bg px-3 py-2 text-sm" placeholder={t('sourceNamePlaceholder')} />
          <Button disabled={!targetId || !name.trim() || busy} onClick={() => void registerSource()}>{t('registerSource')}</Button>
        </div>}
        <label className="block text-sm">{t('registeredSources')}
          <select aria-label={t('registeredSources')} value={sourceId} onChange={event => { setSourceId(event.target.value); setCommit(''); request.current = undefined; }}
            className="mt-2 block w-full rounded border border-border bg-bg px-3 py-2">
            <option value="">{t('selectTarget')}</option>{catalog.data?.sources.map(value =>
              <option key={value.id} value={value.id} disabled={!value.current}>{value.name} · {value.sourceType}{value.current ? '' : ` · ${t('sourceDisabled')}`}</option>)}
          </select>
        </label>
        {source && <div className="mt-3 space-y-2 break-all text-xs text-fg-muted">
          <p>{source.repositoryUrl ?? `${t('s3Snapshot')} · ${source.snapshot?.versionId}`}</p>
          {source.snapshot && <p>Source SHA256: {source.snapshot.sha256}</p>}
          <p>{t('sourceHash')}: {source.contentHash}</p>
          <p>{t('dockerfile')}: {source.dockerfile} · {t('context')}: {source.context}</p>
        </div>}
        {!!catalog.data?.cursor && <Button size="sm" className="mt-3" onClick={() => { setSourceCursor(catalog.data?.cursor); setSourceId(''); }}>{t('previousSources')}</Button>}
        {sourceCursor && <Button size="sm" className="mt-3" onClick={() => { setSourceCursor(undefined); setSourceId(''); }}>{t('recentSources')}</Button>}
        {canBuild && <div className="mt-4 flex flex-wrap items-end gap-3">
          {source && source.sourceType !== 'S3' && <label className="min-w-80 flex-1 text-sm">{t('fullCommitSha')}
            <input aria-label={t('fullCommitSha')} value={commit} maxLength={40} onChange={event => { setCommit(event.target.value); request.current = undefined; }}
              className="mt-2 block w-full rounded border border-border bg-bg px-3 py-2 font-mono text-xs" placeholder={t('commitPlaceholder')} />
          </label>}
          <Button variant="primary" loading={busy} disabled={!source?.current || !!catalog.error ||
            source.sourceType !== 'S3' && !/^[a-fA-F0-9]{40}$/.test(commit)} onClick={() => void startSource()}>{t('startBuild')}</Button>
        </div>}
        <p className="mt-4 text-xs text-fg-muted">{t('buildNote')}</p>
      </Card>
      <Card title={t('historyCard')}>
        {!runs.isLoading && !runs.error && !runs.data?.items.length && <EmptyState title={t('noBuildHistory')} />}
        <div className="space-y-3">{runs.data?.items.map(run => <button key={run.id} type="button"
          onClick={() => { setSelectedRun(run.id); setRecoveryId(''); }} className="block w-full rounded border border-border bg-bg p-3 text-left">
          <span className="flex flex-wrap items-center gap-3"><StatusPill status={run.state} /><span className="text-xs text-fg-muted">{run.createdAt}</span></span>
          <span className="mt-2 block break-all font-mono text-xs">{run.id}</span>
          <span className="mt-1 block break-all text-xs">{run.commit ?? `${t('s3Snapshot')} ${run.snapshot?.versionId ?? ''}`}</span>
        </button>)}</div>
        {!!runs.data?.cursor && <Button size="sm" className="mt-3" onClick={() => setHistoryCursor(runs.data?.cursor)}>{t('previousBuilds')}</Button>}
        {historyCursor && <Button size="sm" className="mt-3" onClick={() => setHistoryCursor(undefined)}>{t('recentBuilds')}</Button>}
      </Card>
      {selectedRun && <Card title={t('detailCard')}>
        <ErrorBox error={detail.error} />
        {detail.data && <>
          <div className="flex flex-wrap items-center gap-3"><StatusPill status={detail.data.state} />
            <span className="text-xs">{detail.data.phase} {detail.data.buildStatus && `· CodeBuild ${detail.data.buildStatus}`}</span>
            {canBuild && (admin || canRegister || detail.data.actor === me.data?.subject) && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.data.state) &&
              <Button variant="danger" size="sm" disabled={busy || detail.data.cancelRequested} onClick={() => void cancelSource(detail.data!)}>{t('cancelButton')}</Button>}
          </div>
          {detail.data.cancelRequested && <p className="mt-2 text-sm">{t('cancelNote')}</p>}
          {detail.data.errorCode && <p role="status" className="mt-3 text-sm">{t('diagnostics', { code: detail.data.errorCode })}</p>}
          {detail.data.state === 'START_UNCERTAIN' && <p className="mt-2 text-sm">{t('startUncertain')}</p>}
          {canRegister && detail.data.state === 'START_UNCERTAIN' && <div className="mt-3 flex flex-wrap gap-2">
            <input aria-label={t('recoveryInput')} value={recoveryId} onChange={event => setRecoveryId(event.target.value)}
              placeholder={t('recoveryPlaceholder', { project: detail.data.codeBuildProjectName })} className="min-w-80 flex-1 rounded border border-border bg-bg px-3 py-2 text-xs" />
            <Button size="sm" disabled={!recoveryId || busy} onClick={() => void recoverSource()}>{t('recoveryButton')}</Button>
          </div>}
          {detail.data.provenance && <dl className="mt-4 space-y-2 break-all text-xs">
            <dt className="text-fg-muted">{t('resolvedImage')}</dt><dd className="font-mono">{detail.data.provenance.output.resolvedImage}</dd>
            <dt className="text-fg-muted">{t('sourceArchiveSha')}</dt><dd>{detail.data.provenance.sourceArchiveSha256}</dd>
            <dt className="text-fg-muted">{t('dockerfileSha')}</dt><dd>{detail.data.provenance.dockerfileSha256}</dd>
            <dt className="text-fg-muted">{t('environment')}</dt><dd>{t('envNote')}</dd>
          </dl>}
          {admin && detail.data.state === 'SUCCEEDED' && detail.data.provenance && <LinkButton className="mt-3" size="sm"
            href={`/image-profiles?${new URLSearchParams({ sourceBuildId: detail.data.id, image: detail.data.provenance.output.resolvedImage })}`}>
            {t('connectImage')}
          </LinkButton>}
          <ErrorBox error={output.error} />
          {detail.data.buildId && <pre aria-label={t('logsLabel')} className="mt-4 max-h-96 overflow-auto rounded border border-border bg-bg p-3 text-xs">{output.data?.lines.join('\n') || t('logsLoading')}</pre>}
          {output.data?.truncated && <p className="text-xs text-fg-muted">{t('logsTruncated')}</p>}
        </>}
      </Card>}
    </>}
    {admin && <OperationsBuilds />}
  </div>;
}

function OperationsBuilds() {
  const t = useT('builds');
  const tc = useT('common');
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
    <h2 className="text-lg font-semibold">{t('adminOps')}</h2>
    <p className="mb-4 text-sm text-fg-muted">{t('adminNote')}</p>
    {(error || projects.error || builds.error) && <ErrorBox error={error ?? projects.error ?? builds.error} />}
    <Card title={t('operationCard')}>
      <div className="flex flex-wrap gap-3">
        <select aria-label={t('projectSelect')} className="rounded border border-border bg-bg px-3 py-2 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">{tc('select')}</option>{projects.data?.map((project) => <option key={project.name} value={project.name}>{project.name}</option>)}
        </select>
        <Button variant="primary" disabled={!selected} loading={busy} onClick={start}>{t('startOp')}</Button>
      </div>
    </Card>
    <Card className="mt-5" title={t('historyCardAdmin')}>
      {!builds.data?.length && <EmptyState title={t('noHistoryAdmin')} />}
      <div className="space-y-3">{builds.data?.map((build) => <div key={build.id} className="rounded border border-border bg-bg p-3">
        <div className="flex flex-wrap items-center gap-3"><StatusPill status={build.status} /><span className="text-sm">{build.phase}</span><span className="text-xs text-fg-muted">{build.startedAt}</span></div>
        <div className="mt-2 break-all font-mono text-xs">{build.id}</div>
        {build.resolvedSourceVersion && <p className="mt-1 break-all text-xs text-fg-muted">{t('historySource')}: {build.resolvedSourceVersion}</p>}
      </div>)}</div>
    </Card>
  </>;
}
