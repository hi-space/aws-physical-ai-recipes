'use client';
import { useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { ExecutionProfile } from '@/server/services/execution-profiles';

interface Registry {
  profiles: ExecutionProfile[]; canApprove: boolean; project: { id: string; name: string };
  requiredNodeConfiguration?: { label: string; taint: string };
}
const field = 'mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm';
const fresh = { id: '', name: '', taskName: '', yaml: '', hostNetwork: false, privileged: false, runAsRoot: false, mounts: '[]', acknowledged: false };

export function ExecutionProfilesPanel() {
  const t = useT('executionProfiles');
  const tc = useT('common');
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

  return <Card title={t('title')} description={t('description')}>
    <p className="text-sm leading-6 text-fg-muted">
      {t('scopeNote')}
    </p>
    <ErrorBox error={registry.error ?? history.error ?? error} />
    {notice && <p role="status" className="mt-3 rounded border border-border p-3 text-sm">{notice}</p>}
    {registry.isLoading && <Spinner label={tc('loading')} />}
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {registry.data?.profiles.map(profile => <button key={profile.id} type="button" onClick={() => choose(profile)}
        className={`rounded border p-3 text-left ${selected?.id === profile.id ? 'border-accent' : 'border-border'}`}>
        <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{profile.name}</span>
          <Badge tone={profile.enabled ? 'warn' : 'neutral'}>{profile.enabled ? `${t('approvalHistory')} v${profile.version}` : tc('disabled')}</Badge></span>
        <span className="mt-2 block text-xs text-fg-muted">{t('dedicatedNodes', { count: profile.nodes.length })} · {t('dedicatedMounts', { count: profile.policy.mounts.length })}</span>
      </button>)}
    </div>
    {!registry.isLoading && !registry.data?.profiles.length && <EmptyState title={t('noProfiles')} hint={t('noProfilesHint')} />}
    {shown && <div className="mt-4 rounded border border-border p-4 text-xs">
      <label className="text-fg-muted">{t('approvalHistory')}
        <select aria-label="Approval version" value={viewVersion ?? selected?.version} className={field} onChange={e => setViewVersion(Number(e.target.value))}>
          {Array.from({ length: Math.min(selected?.version ?? 1, 100) }, (_, index) => (selected?.version ?? 1) - index)
            .map(version => <option key={version} value={version}>v{version}</option>)}
        </select>
      </label>
      <p className="mt-3 break-all">{t('approvedTaskHash')}: <code>{shown.approvedTaskHash}</code></p>
      <p className="mt-1">{t('approvedBy')} {shown.approvedBy} · {shown.createdAt}</p>
      <p className="mt-3 text-fg-muted">{t('referencingNote')}</p>
      <pre className="mt-2 overflow-auto rounded bg-bg p-3">{`executionProfile:\n  id: ${shown.id}\n  version: ${shown.version}`}</pre>
      {registry.data?.canApprove && selected?.enabled && <Button className="mt-3" size="sm" variant="danger" disabled={busy} onClick={() => void action(async () => {
        await api(`/api/execution-profiles/${selected.id}`, { method: 'DELETE', json: { expectedVersion: selected.version } });
        setSelected(undefined); setViewVersion(undefined); await registry.refetch();
        setNotice(t('approvalRevoked'));
      })}>{t('revokeApproval')}</Button>}
    </div>}
    {registry.data?.canApprove && <details className="mt-5" open={!!selected}>
      <summary className="cursor-pointer text-sm font-medium">{t('approval')}</summary>
      <form className="mt-4 grid gap-4 md:grid-cols-3" onSubmit={event => {
        event.preventDefault(); void action(async () => {
          const profile = await api<ExecutionProfile>('/api/execution-profiles', { method: 'POST', json: {
            id: draft.id, name: draft.name, taskName: draft.taskName, yaml: draft.yaml,
            ...(selected ? { expectedVersion: selected.version } : {}),
            acknowledgeTrustBoundary: draft.acknowledged,
            policy: { hostNetwork: draft.hostNetwork, privileged: draft.privileged, runAsRoot: draft.runAsRoot, mounts: JSON.parse(draft.mounts) },
          } });
          await registry.refetch(); choose(profile); setNotice(`v${profile.version} ${t('referencingNote')}`);
        });
      }}>
        {(['id', 'name', 'taskName'] as const).map((key, index) => <label key={key} className="text-xs text-fg-muted">
          {[t('profileId'), t('profileName'), t('taskName')][index]}
          <input className={field} required readOnly={key === 'id' && !!selected} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
        </label>)}
        <label className="text-xs text-fg-muted md:col-span-3">{t('approvalYaml')}
          <textarea className={`${field} font-mono text-xs`} required rows={9} value={draft.yaml} onChange={e => setDraft(d => ({ ...d, yaml: e.target.value }))} />
        </label>
        {(['hostNetwork', 'privileged', 'runAsRoot'] as const).map((key, index) => <label key={key} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.checked }))} />
          {[t('hostNetwork'), t('privilegedContainer'), t('rootUser')][index]}
        </label>)}
        <label className="text-xs text-fg-muted md:col-span-3">{t('hostMounts')}
          <textarea className={`${field} font-mono text-xs`} rows={4} value={draft.mounts} onChange={e => setDraft(d => ({ ...d, mounts: e.target.value }))} />
          <span className="mt-1 block">{t('hostMountsHelp')}</span>
        </label>
        {registry.data.requiredNodeConfiguration && <div className="rounded border border-border p-3 text-xs md:col-span-3">
          <p>{t('nodeConfiguration')}</p>
          <p className="mt-2 break-all font-mono">{registry.data.requiredNodeConfiguration.label}</p>
          <p className="mt-1 break-all font-mono">{registry.data.requiredNodeConfiguration.taint}</p>
        </div>}
        <label className="flex items-start gap-2 text-xs leading-5 md:col-span-3">
          <input className="mt-1" type="checkbox" required checked={draft.acknowledged} onChange={e => setDraft(d => ({ ...d, acknowledged: e.target.checked }))} />
          {t('trustAcknowledge')}
        </label>
        <div className="flex gap-2 md:col-span-3"><Button type="submit" variant="primary" loading={busy} disabled={!draft.acknowledged}>{t('inspectAndApprove')}</Button>
          <Button type="button" variant="ghost" onClick={() => { setSelected(undefined); setViewVersion(undefined); setDraft(fresh); }}>{t('newProfile')}</Button></div>
      </form>
    </details>}
  </Card>;
}
