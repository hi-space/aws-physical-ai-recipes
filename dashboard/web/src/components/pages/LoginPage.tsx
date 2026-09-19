'use client';
import { useState, type FormEvent } from 'react';
import { Button, Card, Field, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';

/**
 * Only follow same-origin absolute paths. A value must start with a single `/`
 * and no second `/` or `\` (which browsers can treat as a protocol-relative host),
 * carry no scheme, and contain no control characters (CR/LF etc. that could be
 * used for header/URL smuggling) — anything else, including `javascript:` and
 * empty, falls back to `/` so a crafted `?next=` cannot bounce the user off-site.
 */
export function safeNext(param: string | null): string {
  if (!param || param[0] !== '/' || param[1] === '/' || param[1] === '\\') return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(param)) return '/';
  return param;
}

/** Maps an auth API response to the next form state. */
export function nextStep(r: { status: number; body: unknown }): 'done' | 'newPassword' | 'failed' {
  const body = (r.body ?? {}) as { ok?: unknown; challenge?: unknown };
  if (r.status === 200 && body.ok === true) return 'done';
  if (r.status === 200 && body.challenge === 'NEW_PASSWORD_REQUIRED') return 'newPassword';
  return 'failed';
}

async function postJson(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  // Not api() — that redirects on 401, which would defeat showing an inline error.
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export function LoginPage() {
  const t = useT('login');
  const [step, setStep] = useState<'password' | 'newPassword'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [session, setSession] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function goNext() {
    window.location.assign(safeNext(new URLSearchParams(window.location.search).get('next')));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await postJson('/api/auth/login', { username, password });
      const s = nextStep(r);
      if (s === 'done') return goNext();
      if (s === 'newPassword') {
        setSession(((r.body ?? {}) as { session?: string }).session ?? '');
        setStep('newPassword');
        return;
      }
      setError(t('failed'));
    } catch {
      setError(t('networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await postJson('/api/auth/challenge', { username, session, newPassword });
      if (nextStep(r) === 'done') return goNext();
      setError(t('challengeFailed'));
    } catch {
      setError(t('networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Card title={step === 'newPassword' ? t('newPasswordTitle') : t('title')} description={t('description')}>
          {step === 'password' ? (
            <form onSubmit={submit} className="space-y-4">
              <Field label={t('username')}>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
              </Field>
              <Field label={t('password')}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
              {error && <p className="text-sm text-err">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                {busy ? t('submitting') : t('submit')}
              </Button>
            </form>
          ) : (
            <form onSubmit={confirm} className="space-y-4">
              <Field label={t('newPassword')} help={t('newPasswordHelp')}>
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" autoFocus required />
              </Field>
              {error && <p className="text-sm text-err">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                {busy ? t('submitting') : t('confirm')}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
