'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Badge, Button, Card, CopyButton, Dialog, EmptyState, ErrorBox, Field, Input, Select, Spinner, Table } from '@/components/ui';
import { api, useApi, useMe } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { CredentialMetadata } from '@/server/services/credentials';
import type { ApiScope, ApiTokenMetadata } from '@/server/auth/api-tokens';

interface CredentialList { projectId: string; credentials: CredentialMetadata[]; capabilities: { canWrite: boolean; canShare: boolean; canRegisterLegacy: boolean } }
interface TokenList { projectId: string; tokens: ApiTokenMetadata[]; availableScopes: ApiScope[] }

export function AccessPage() {
  const t = useT('access');
  const tr = useT('resources');
  const tc = useT('common');
  const me = useMe();
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

  const scopeLabels: Record<ApiScope, string> = {
    'workflows:read': t('tokenScopes'),
    'workflows:write': t('tokenScopes'),
    'datasets:read': t('tokenScopes'),
    'datasets:write': t('tokenScopes'),
    'sessions:read': t('tokenScopes'),
    'sessions:write': t('tokenScopes'),
    'models:read': t('tokenScopes'),
    'metrics:read': t('tokenScopes'),
  };

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
        form.reset(); setNotice(mode === 'legacy' ? t('legacyRegistered') : t('credentialRegistered'));
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
      if (!created.token || !created.metadata?.id) throw new Error(tc('errorLoad'));
      setIssuedToken(created.token); form.reset(); await tokens.refetch();
    });
  }

  function rotate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!rotating) return;
    const form = event.currentTarget; const value = String(new FormData(form).get('value') ?? ''); const id = rotating.id;
    void perform(async () => {
      try {
        await api(`/api/credentials/${id}/rotate`, { method: 'POST', json: { value } });
        setRotating(null); setNotice(t('credentialRotated')); await credentials.refetch();
      } finally { form.reset(); }
    });
  }

  const res = me.data?.resources;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('userPool'), value: res?.cognito?.userPoolId, console: res?.cognito ? { kind: 'cognito-user-pool', id: res.cognito.userPoolId } : undefined },
        ]}
      />
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">{t('projectSelectHint')} {projectId && <Badge>{t('projectBadge', { projectId })}</Badge>}</p>
        {error !== undefined && <ErrorBox error={error} />}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {!consistentProject && <ErrorBox error={{ message: t('inconsistentProject') }} />}

        <Card title={t('credentialsTitle')} description={t('credentialsDesc')}>
          {credentials.error && <ErrorBox error={credentials.error} />}
          {credentials.isLoading && <Spinner label={t('credentialsLoading')} />}
          {credentials.data && <>
            {capabilities?.canWrite && consistentProject && !credentials.error && (
              <form onSubmit={createCredential} className="space-y-3 mb-5">
                {capabilities.canRegisterLegacy && <Field label={t('registrationMode')}><Select value={mode} onChange={(event) => setMode(event.target.value as 'value' | 'legacy')} disabled={busy}><option value="value">{t('modeNewSecret')}</option><option value="legacy">{t('modeLegacy')}</option></Select></Field>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t('credentialName')}><Input name="name" required maxLength={80} disabled={busy} /></Field>
                  <Field label={t('credentialKind')}><Select name="kind" disabled={busy}><option value="hf">Hugging Face</option><option value="ngc">NVIDIA NGC</option><option value="generic">{tc('value')}</option></Select></Field>
                  <Field label={t('credentialScope')}><Select name="scope" disabled={busy}><option value="private">{t('scopePrivate')}</option>{capabilities.canShare && <option value="project">{t('scopeProject')}</option>}</Select></Field>
                </div>
                {mode === 'legacy' ? <Field label={t('secretRef')} help={t('secretRefHelp')}><Input name="ref" required placeholder="/groot/hf-token" disabled={busy} /></Field>
                  : <Field label={t('secretValue')} help={t('secretValueHelp')}><Input name="value" type="password" autoComplete="new-password" required disabled={busy} /></Field>}
                <Button type="submit" variant="primary" loading={busy}>{t('credentialRegister')}</Button>
              </form>
            )}
            {credentials.data.credentials.length ? <Table head={[t('credentialName'), t('credentialScope'), t('credentialStatus'), 'Ref', tc('actions')]} dense>
              {credentials.data.credentials.map((credential) => {
                const editable = consistentProject && !credentials.error && capabilities?.canWrite && (credential.scope === 'private' || capabilities.canShare);
                const available = ['READY', 'REGISTERED', 'ERROR'].includes(credential.status);
                return <tr key={credential.id}>
                  <td>{credential.name} <Badge>{credential.kind}</Badge></td>
                  <td>{credential.scope === 'private' ? t('scopePrivate') : t('scopeProject')}</td>
                  <td><Badge tone={credential.status === 'ERROR' ? 'err' : credential.status === 'READY' ? 'ok' : 'neutral'}>{credential.status === 'REGISTERED' ? t('statusReferenceUnverified') : credential.status}</Badge></td>
                  <td><code className="text-xs break-all">{credential.ref}</code><CopyButton text={credential.ref} /></td>
                  <td>{editable && <div className="flex gap-2">
                    {credential.managed && <Button size="sm" onClick={() => setRotating(credential)} disabled={busy || !available}>{t('credentialRotate')}</Button>}
                    <Button size="sm" variant="danger" disabled={busy || !available} onClick={() => {
                      if (!confirm(credential.managed ? t('legacyDeleteConfirm') : t('credentialDeleteConfirm'))) return;
                      void perform(async () => { await api(`/api/credentials/${credential.id}`, { method: 'DELETE' }); await credentials.refetch(); setNotice(t('credentialDeleted')); });
                    }}>{t('credentialDelete')}</Button>
                  </div>}</td>
                </tr>;
              })}
            </Table> : !credentials.error && <EmptyState title={t('noCreds')} />}
          </>}
        </Card>

        <Card title={t('tokensTitle')} description={t('tokensDesc')}>
          {tokens.error && <ErrorBox error={tokens.error} />}
          {tokens.isLoading && <Spinner label={t('tokensLoading')} />}
          {tokens.data && <>
            {!tokens.error && consistentProject && <form onSubmit={createToken} className="space-y-3 mb-5">
              <div className="grid gap-3 sm:grid-cols-2"><Field label={t('tokenName')}><Input name="name" required maxLength={80} disabled={busy} /></Field><Field label={t('tokenExpiry')}><Input name="days" type="number" min={1} max={30} step={1} defaultValue={7} required disabled={busy} /></Field></div>
              <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="text-xs mb-2">{t('tokenScopes')}</legend>{tokens.data.availableScopes.map((scope) => <label key={scope} className="text-xs flex gap-2"><input type="checkbox" name="scopes" value={scope} defaultChecked={scope === 'workflows:read'} disabled={busy} />{scopeLabels[scope]} <code>{scope}</code></label>)}</fieldset>
              <Button type="submit" variant="primary" loading={busy}>{t('tokenIssue')}</Button>
            </form>}
            {issuedToken && <div role="status" className="rounded border border-accent p-3 mb-4 space-y-2">
              <p className="text-sm">{t('tokenWarning')}</p>
              <div className="flex gap-2"><Input type="password" readOnly value={issuedToken} aria-label={t('tokenIssue')} /><CopyButton text={issuedToken} /></div>
              <Button size="sm" variant="ghost" onClick={() => setIssuedToken('')}>{t('tokenHidden')}</Button>
            </div>}
            {tokens.data.tokens.length ? <Table head={[t('tokenName'), tc('description'), t('tokenExpiry'), tc('status'), tc('actions')]} dense>{tokens.data.tokens.map((token) => <tr key={token.id}>
              <td>{token.name}</td><td className="text-xs">{token.scopes.join(', ')}</td><td className="text-xs">{token.expiresAt}</td><td>{token.revokedAt ? t('tokenRevoked') : Date.parse(token.expiresAt) <= Date.now() ? t('tokenExpired') : t('tokenActive')}</td>
              <td>{!token.revokedAt && <Button size="sm" variant="danger" disabled={busy || !!tokens.error || !consistentProject} onClick={() => { if (!confirm(t('tokenRevokeConfirm'))) return; void perform(async () => { await api(`/api/tokens/${token.id}`, { method: 'DELETE' }); setIssuedToken(''); await tokens.refetch(); setNotice(t('tokenRevoked')); }); }}>{tc('delete')}</Button>}</td>
            </tr>)}</Table> : !tokens.error && <EmptyState title={t('noTokens')} />}
          </>}
        </Card>

        <Card title={t('cliConnection')}><p className="text-sm">{t('cliHint')}</p><code className="block text-xs mt-2">{t('cliCommand')}</code><p className="text-xs text-fg-muted mt-2">{t('cliWarning')}</p></Card>
      </div>
      <Dialog open={!!rotating} onClose={() => !busy && setRotating(null)} title={t('credentialRotate')}>
        <form onSubmit={rotate} className="space-y-3"><Field label={t('secretValue')}><Input name="value" type="password" required autoComplete="new-password" disabled={busy} /></Field><Button type="submit" variant="primary" loading={busy}>{tc('save')}</Button></form>
      </Dialog>
    </>
  );
}
