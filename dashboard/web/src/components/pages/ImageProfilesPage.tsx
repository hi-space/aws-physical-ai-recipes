'use client';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { ImageProfile, ImagePreflight } from '@/server/services/image-profiles';
import { ExecutionProfilesPanel } from './ExecutionProfilesPanel';

interface Registry { project: { id: string; name: string }; profiles: ImageProfile[]; capabilities: { canApprove: boolean; canSeed: boolean } }
const base = '/api/image-profiles';
const empty = { id: '', name: '', image: '', sourceBuildId: '', cpu: '1', memory: '1', gpu: '0', vram: '0', platforms: '' };
const fieldClass = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';

export function ImageProfilesPage() {
  const t = useT('imageProfiles');
  const tc = useT('common');
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
      setDraft({ ...empty, id: `build-${build.slice(3, 15)}`, name: t('imageTitle'), image, sourceBuildId: build });
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
      await registry.refetch(); choose(saved); setNotice(`v${saved.version} ${tc('save')}`);
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
      <div><p className="text-xs uppercase tracking-wider text-fg-faint">{t('imageTitle')} / COMPUTE CONTRACT</p>
        <h1 className="mt-1 text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-2 text-sm text-fg-muted">{registry.data?.project.name ?? tc('value')} · {t('description')}</p></div>
      <Badge tone="warn">{t('readOnlyWarning')}</Badge>
    </header>
    <ErrorBox error={registry.error ?? error} />
    {notice && <p role="status" className="rounded border border-border bg-bg-elev p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label={t('loading')} />}
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <Card title={t('projectImages')} actions={canApprove && <Button size="sm" disabled={busy} onClick={() => { setSelected(''); setVersion(undefined); setDraft(empty); }}>{t('newProfile')}</Button>}>
        {!registry.data?.profiles.length && <EmptyState title={t('noImages')} hint={t('noImagesHint')} />}
        <div className="space-y-2">{registry.data?.profiles.map(value => <button type="button" key={value.id} onClick={() => choose(value)}
          className={`w-full rounded border p-3 text-left ${selected === value.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}>
          <span className="flex justify-between gap-2"><span className="font-medium">{value.name}</span>
            <Badge tone={!value.enabled ? 'neutral' : value.approved ? 'info' : 'warn'}>{!value.enabled ? t('imageDisabled') : value.approved ? `${t('approvedVersion', { version: value.version })}` : t('pendingApproval')}</Badge></span>
          <span className="mt-2 block truncate font-mono text-xs text-fg-muted">{value.image.resolvedImage}</span>
          <span className="mt-2 block text-xs text-fg-faint">{value.image.architectures.join(' / ')} · {t('inspectionEvidence')} {value.image.inspectedAt}</span>
        </button>)}</div>
        {registry.data?.capabilities.canSeed && <Button className="mt-4" variant="primary" loading={busy} onClick={() => void action(async () => {
          const seeded = await api<{ profiles: ImageProfile[]; findings: { message: string }[] }>(`${base}/seed`, { method: 'POST', json: {} });
          await registry.refetch(); setNotice(t('candidatesMsg', { count: seeded.profiles.length, findings: seeded.findings.map(f => f.message).join(' ') }));
        })}>{t('seedCandidates')}</Button>}
        <p className="mt-3 text-xs leading-5 text-fg-muted">{t('seedNote')}</p>
      </Card>
      <Card title={profile ? `${profile.name} · ${t('evidenceHistory')}` : t('inspectionScope')}>
        {profile ? <>
          <label className="text-xs text-fg-muted">{tc('version')}<select className={fieldClass} value={version ?? current?.version} onChange={e => setVersion(Number(e.target.value))}>
            {Array.from({ length: Math.min(current?.version ?? 1, 100) }, (_, i) => (current?.version ?? 1) - i).map(v => <option key={v} value={v}>v{v}</option>)}
          </select></label>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs text-fg-muted">{t('resolvedImage')}</dt><dd className="mt-1 break-all font-mono text-xs">{profile.image.resolvedImage}</dd></div>
            <div><dt className="text-xs text-fg-muted">{t('inspectionEvidence')}</dt><dd>{profile.image.source} · {profile.image.inspectedAt}</dd></div>
            <div><dt className="text-xs text-fg-muted">{t('approvalRequirements')}</dt><dd>{profile.requirements.minCpu} vCPU / {profile.requirements.minMemoryMiB / 1024} GiB RAM / GPU {profile.requirements.minGpu} / per GPU {profile.requirements.minGpuMemoryMiB ? `${profile.requirements.minGpuMemoryMiB / 1024} GiB VRAM` : tc('notAvailable')}</dd></div>
            <div><dt className="text-xs text-fg-muted">{t('approvedBy')} / {t('createdAt')}</dt><dd>{profile.approvedBy ?? tc('notAvailable')} / {profile.createdBy}</dd></div>
            {profile.sourceBuild && <div><dt className="text-xs text-fg-muted">{t('sourceProvenance')}</dt>
              <dd className="mt-1 break-all font-mono text-xs">{profile.sourceBuild.provenance.sourceArchiveSha256}</dd>
              <dd className="mt-2"><LinkButton size="sm" href={`/builds?run=${profile.sourceBuild.id}`}>{t('linkedBuild')}</LinkButton></dd>
              <dd className="mt-2 text-xs text-fg-muted">{t('sourceTrackingNote')}</dd>
            </div>}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2"><Button onClick={example} variant="secondary">{t('generateExample')}</Button>
            {canApprove && current?.enabled && <Button variant="danger" disabled={busy} onClick={() => void action(async () => {
              await api(`${base}/${selected}`, { method: 'DELETE' }); await registry.refetch(); await detail.refetch(); setNotice(t('disabledMsg'));
            })}>{t('disableProfile')}</Button>}</div>
        </> : <p className="text-sm leading-6 text-fg-muted">{t('scopeHint')}</p>}
        <ErrorBox error={detail.error} />
      </Card>
    </div>
    {canApprove && <Card title={selected ? t('approval') : tc('create')}>
      <p className="mb-4 text-xs text-fg-muted">{t('approvalNote')}</p>
      <form onSubmit={approve} className="grid gap-4 md:grid-cols-4">
        {[['id', t('profileId')], ['name', t('profileName')], ['image', t('privateEcr')], ['platforms', t('platforms')], ['sourceBuildId', t('sourceBuildId')],
          ['cpu', t('minCpu')], ['memory', t('minMemory')], ['gpu', t('minGpu')], ['vram', t('minVram')]].map(([key, label]) =>
          <label key={key} className={`text-xs text-fg-muted ${key === 'image' ? 'md:col-span-2' : ''}`}>{label}
            <input className={fieldClass} required={!['platforms', 'sourceBuildId'].includes(key)} readOnly={key === 'id' && !!selected}
              type={['cpu', 'memory', 'gpu', 'vram'].includes(key) ? 'number' : 'text'} min="0" step={key === 'gpu' ? '1' : 'any'}
              value={draft[key as keyof typeof draft]} onChange={e => setDraft(value => ({ ...value, [key]: e.target.value }))} />
          </label>)}
        <div className="md:col-span-4"><Button type="submit" variant="primary" loading={busy}>{t('inspectAndApprove')}</Button></div>
      </form>
    </Card>}
    <ExecutionProfilesPanel />
    <Card title={t('preflightTitle')} description={t('preflightDesc')}>
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        setResult(undefined); setResult(await api<ImagePreflight>(`${base}/preflight`, { method: 'POST', json: { yaml } }));
      }); }}>
        <textarea aria-label={t('preflightYaml')} required maxLength={256 * 1024} rows={9} value={yaml} onChange={event => { setYaml(event.target.value); setResult(undefined); }}
          className={`${fieldClass} font-mono text-xs`} placeholder={t('preflightYaml')} />
        <Button type="submit" className="mt-3" variant="primary" loading={busy} disabled={!yaml.trim()}>{t('checkCompatibility')}</Button>
      </form>
      {result && <div className="mt-5 space-y-3" role="status">
        <div className="flex flex-wrap justify-between gap-2"><Badge tone={result.status === 'blocked' ? 'err' : 'warn'}>{result.status === 'blocked' ? t('blockingIssues') : t('checkNeeded')}</Badge>
          <span className="text-xs text-fg-muted">{t('checkedAt', { date: result.checkedAt })}</span></div>
        {result.tasks.map(task => <section key={task.task} className="rounded border border-border p-3">
          <h3 className="text-sm font-semibold">{task.task} · {task.profileId ?? t('noApprovedProfile')}{task.profileVersion && ` v${task.profileVersion}`}</h3>
          <p className="mt-1 text-xs text-fg-muted">{t('compatibleNodes')}: {task.compatibleNodes.join(', ') || tc('notAvailable')} · {t('driver')}: {task.driver} · {t('modelAccess')}: {task.modelAccess}</p>
          <ul className="mt-2 space-y-1 text-xs">{task.findings.map((finding, i) => <li key={i} className={finding.severity === 'error' ? 'text-err' : 'text-fg-muted'}>{finding.severity} · {finding.message}</li>)}</ul>
        </section>)}
        <details><summary className="cursor-pointer text-xs text-fg-muted">{t('resolvedDigests')}</summary><pre className="mt-2 overflow-auto rounded bg-bg p-3 text-xs">{JSON.stringify(result.resolvedImageDigests, null, 2)}</pre></details>
      </div>}
    </Card>
  </div>;
}
