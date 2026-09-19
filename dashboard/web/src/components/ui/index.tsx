'use client';
import * as React from 'react';
import Link from 'next/link';
import { classNames as cx } from '@/lib/format';
import { AlertCircle, Check, ChevronDown, Copy, Info, Loader2, X } from 'lucide-react';
import { useT, type MessageKey, type Translator } from '@/lib/i18n';

// ---------------------------------------------------------------- Button
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', loading, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  const v: Record<BtnVariant, string> = {
    primary: 'bg-accent-strong text-white hover:bg-blue-500 border-transparent',
    secondary: 'bg-bg-elev-2 hover:bg-[#1e2637] border-border-strong text-fg',
    ghost: 'bg-transparent hover:bg-bg-elev-2 border-transparent text-fg-muted hover:text-fg',
    danger: 'bg-transparent hover:bg-red-500/10 border-red-500/40 text-err',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed', size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm', v[variant], className)}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, className, variant = 'secondary', size = 'md' }: { href: string; children: React.ReactNode; className?: string; variant?: BtnVariant; size?: 'sm' | 'md' }) {
  const v: Record<BtnVariant, string> = {
    primary: 'bg-accent-strong text-white hover:bg-blue-500 border-transparent',
    secondary: 'bg-bg-elev-2 hover:bg-[#1e2637] border-border-strong text-fg',
    ghost: 'bg-transparent hover:bg-bg-elev-2 border-transparent text-fg-muted hover:text-fg',
    danger: 'bg-transparent hover:bg-red-500/10 border-red-500/40 text-err',
  };
  return (
    <Link href={href} className={cx('inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors', size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm', v[variant], className)}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- Card
export function Card({ title, actions, children, className, padded = true, description }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-border bg-bg-elev', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
            {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- Stat
export function Stat({ label, value, sub, tone, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'ok' | 'warn' | 'err' | 'info'; className?: string }) {
  const t = { ok: 'text-ok', warn: 'text-warn', err: 'text-err', info: 'text-info' };
  return (
    <div className={cx('rounded-lg border border-border bg-bg-elev px-5 py-4', className)}>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      <div className={cx('num mt-1.5 text-2xl font-semibold leading-tight', tone && t[tone])}>{value}</div>
      {sub && <div className="mt-1 text-[13px] text-fg-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Badge / StatusPill
export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent'; className?: string }) {
  const t = {
    neutral: 'bg-bg-elev-2 text-fg-muted border-border-strong',
    ok: 'bg-emerald-500/10 text-ok border-emerald-500/30',
    warn: 'bg-amber-500/10 text-warn border-amber-500/30',
    err: 'bg-red-500/10 text-err border-red-500/30',
    info: 'bg-blue-500/10 text-info border-blue-500/30',
    accent: 'bg-accent/10 text-accent border-accent/30',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium leading-tight', t[tone], className)}>{children}</span>;
}

const STATUS_TONE: Record<string, { tone: 'neutral' | 'ok' | 'warn' | 'err' | 'info'; pulse?: boolean }> = {
  SUCCEEDED: { tone: 'ok' }, Succeeded: { tone: 'ok' }, Complete: { tone: 'ok' }, InService: { tone: 'ok' }, Running: { tone: 'info', pulse: true }, RUNNING: { tone: 'info', pulse: true },
  Active: { tone: 'ok' }, ACTIVE: { tone: 'ok' }, ready: { tone: 'ok' }, Ready: { tone: 'ok' }, Schedulable: { tone: 'ok' }, admitted: { tone: 'ok' }, Enabled: { tone: 'ok' }, Completed: { tone: 'ok' }, AVAILABLE: { tone: 'ok' }, SUCCEEDED_: { tone: 'ok' },
  PENDING: { tone: 'warn' }, Pending: { tone: 'warn', pulse: true }, QUEUED: { tone: 'warn', pulse: true }, pending: { tone: 'warn', pulse: true }, WAITING: { tone: 'neutral' }, Creating: { tone: 'warn', pulse: true }, Updating: { tone: 'warn', pulse: true }, Executing: { tone: 'info', pulse: true }, InProgress: { tone: 'info', pulse: true }, Starting: { tone: 'warn', pulse: true }, Stopping: { tone: 'warn', pulse: true }, starting: { tone: 'warn', pulse: true }, stopping: { tone: 'warn', pulse: true }, running: { tone: 'ok' },
  FAILED: { tone: 'err' }, Failed: { tone: 'err' }, Error: { tone: 'err' }, Unschedulable: { tone: 'err' }, evicted: { tone: 'err' }, Stopped: { tone: 'neutral' }, stopped: { tone: 'neutral' }, Deleting: { tone: 'err', pulse: true }, DEGRADED: { tone: 'err' },
  CANCELLED: { tone: 'neutral' }, SKIPPED: { tone: 'neutral' }, Cancelled: { tone: 'neutral' }, Suspended: { tone: 'neutral' }, finished: { tone: 'neutral' }, missing: { tone: 'err' },
  CANCELLING: { tone: 'warn', pulse: true }, FINALIZING: { tone: 'info', pulse: true }, UNREADY: { tone: 'warn' }, READY: { tone: 'ok' },
};
/** Known states → common.st* labels. English shows the raw state so operators still recognise the API value. */
const STATUS_LABEL: Record<string, MessageKey<'common'>> = {
  SUCCEEDED: 'stSucceeded', Succeeded: 'stSucceeded', Complete: 'stCompleted', Completed: 'stCompleted', InService: 'stInService',
  Running: 'stRunning', RUNNING: 'stRunning', running: 'stRunning', Executing: 'stExecuting', InProgress: 'stInProgress',
  Active: 'stActive', ACTIVE: 'stActive', ready: 'stReady', Ready: 'stReady', READY: 'stReady', Schedulable: 'stSchedulable', admitted: 'stAdmitted',
  Enabled: 'stEnabled', AVAILABLE: 'stAvailable', PENDING: 'stPending', Pending: 'stPending', pending: 'stPending', QUEUED: 'stQueued', WAITING: 'stWaiting',
  Creating: 'stCreating', Updating: 'stUpdating', Starting: 'stStarting', starting: 'stStarting', Stopping: 'stStopping', stopping: 'stStopping',
  FAILED: 'stFailed', Failed: 'stFailed', Error: 'stError', Unschedulable: 'stUnschedulable', evicted: 'stEvicted', Stopped: 'stStopped', stopped: 'stStopped',
  Deleting: 'stDeleting', DEGRADED: 'stDegraded', CANCELLED: 'stCancelled', Cancelled: 'stCancelled', CANCELLING: 'stCancelling', FINALIZING: 'stFinalizing',
  SKIPPED: 'stSkipped', Suspended: 'stSuspended', finished: 'stFinished', missing: 'stMissing', UNREADY: 'stUnready', unknown: 'stUnknown',
};
/** Localised label for a known state; English keeps the raw API value, unknown states fall back to the value itself. */
export function statusLabel(tc: Translator<'common'>, status?: string): string {
  const s = status ?? 'unknown';
  const key = STATUS_LABEL[s];
  return tc.locale === 'en' || !key ? s : tc(key);
}
export function StatusPill({ status, className }: { status?: string; className?: string }) {
  const tc = useT('common');
  const s = status ?? 'unknown';
  const m = STATUS_TONE[s] ?? { tone: 'neutral' as const };
  const label = statusLabel(tc, s);
  return (
    <Badge tone={m.tone} className={className}>
      <span className={cx('inline-block h-1.5 w-1.5 rounded-full bg-current', m.pulse && 'pulse')} />
      <span title={label !== s ? s : undefined}>{label}</span>
    </Badge>
  );
}

// ---------------------------------------------------------------- Inputs
export const inputCls = 'h-9 w-full rounded-md border border-border-strong bg-bg px-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50';
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none', props.className)} />;
}
export function Select({ children, className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select {...rest} className={cx(inputCls, 'appearance-none pr-7')}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-2.5 text-fg-faint" />
    </div>
  );
}
export function Field({ label, help, children, className }: { label: React.ReactNode; help?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-fg-muted">{label}</span>
      {children}
      {help && <span className="mt-1.5 block text-xs text-fg-faint">{help}</span>}
    </label>
  );
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[13px] text-fg-muted">
      <span className={cx('relative h-4 w-7 rounded-full transition-colors', checked ? 'bg-accent-strong' : 'bg-border-strong')}>
        <span className={cx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform', checked ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- Tabs
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { id: T; label: React.ReactNode; count?: number }[]; className?: string }) {
  return (
    <div className={cx('flex items-center gap-1 border-b border-border', className)}>
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          className={cx('-mb-px flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-sm transition-colors', value === it.id ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg')}
        >
          {it.label}
          {it.count !== undefined && <span className="num rounded bg-bg-elev-2 px-1.5 text-xs text-fg-muted">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Dialog
export function Dialog({ open, onClose, title, children, footer, width = 'md' }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: 'md' | 'lg' | 'xl' }) {
  const tc = useT('common');
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  const w = { md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full rounded-lg border border-border-strong bg-bg-elev shadow-2xl', w[width])} role="dialog" aria-modal>
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-fg-muted hover:text-fg" aria-label={tc('close')}>
            <X size={16} />
          </button>
        </header>
        <div className="p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Feedback
export function EmptyState({ title, hint, action, icon }: { title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-fg-faint">{icon ?? <Info size={24} />}</div>
      <div className="text-base font-medium text-fg">{title}</div>
      {hint && <div className="max-w-md text-sm text-fg-muted">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  const tc = useT('common');
  if (!error) return null;
  const e = error as { message?: string; details?: { issues?: string[] }; code?: string };
  return (
    <div className={cx('flex items-start gap-2.5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-err', className)}>
      <AlertCircle size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="break-words">{e.message ?? String(error)}</div>
        {e.details?.issues && (
          <ul className="mt-1 list-disc pl-4 text-xs text-red-300">
            {e.details.issues.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        )}
        {e.code === 'not_configured' && <div className="mt-1 text-xs text-red-300">{tc('notConfiguredHint')}</div>}
      </div>
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-bg-elev-2', className)} />;
}
export function Spinner({ label }: { label?: string }) {
  const tc = useT('common');
  return (
    <div className="flex items-center gap-2 px-2 py-8 text-sm text-fg-muted">
      <Loader2 size={15} className="animate-spin" /> {label ?? tc('loading')}
    </div>
  );
}

// ---------------------------------------------------------------- Code / KeyValue / Copy
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const tc = useT('common');
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cx('inline-flex items-center rounded p-1 text-fg-faint hover:bg-bg-elev-2 hover:text-fg', className)}
      aria-label={done ? tc('copied') : tc('copy')}
      title={done ? tc('copied') : tc('copy')}
    >
      {done ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
    </button>
  );
}
export function CodeBlock({ code, className, copy = true, lang }: { code: string; className?: string; copy?: boolean; lang?: string }) {
  return (
    <div className={cx('relative rounded-md border border-border bg-bg', className)}>
      {lang && <span className="absolute left-2 top-1 text-[10px] uppercase text-fg-faint">{lang}</span>}
      {copy && <CopyButton text={code} className="absolute right-1 top-1" />}
      <pre className="scrollbar-thin mono overflow-auto p-3 pt-5 text-[13px] leading-relaxed text-fg">{code}</pre>
    </div>
  );
}
export function KeyValue({ items, className }: { items: { k: React.ReactNode; v: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-[13px]', className)}>
      {items.map((it, i) => (
        <React.Fragment key={i}>
          <dt className="text-fg-faint">{it.k}</dt>
          <dd className="min-w-0 break-all text-fg">{it.v ?? '—'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
export function Bar({ value, max, tone = 'accent', label }: { value: number; max: number; tone?: 'accent' | 'ok' | 'warn' | 'err'; label?: React.ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const c = { accent: 'bg-accent-strong', ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err' };
  return (
    <div>
      {label && <div className="mb-1 flex justify-between text-xs text-fg-muted">{label}</div>}
      <div className="h-1.5 w-full overflow-hidden rounded bg-bg-elev-2">
        <div className={cx('h-full rounded', pct > 90 ? 'bg-err' : c[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
export function Table({ head, children, className, dense }: { head: React.ReactNode[]; children: React.ReactNode; className?: string; dense?: boolean }) {
  return (
    <div className={cx('scrollbar-thin overflow-x-auto', className)}>
      <table className={cx('tbl', dense && '[&_td]:py-1.5')}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Toast({ message, tone = 'ok', onClose }: { message: string; tone?: 'ok' | 'err'; onClose: () => void }) {
  React.useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={cx('fixed bottom-5 right-5 z-50 rounded-md border px-4 py-2.5 text-sm shadow-lg', tone === 'ok' ? 'border-emerald-500/40 bg-bg-elev text-ok' : 'border-red-500/40 bg-bg-elev text-err')}>{message}</div>
  );
}

// ---------------------------------------------------------------- Disclosure / Segmented
/** Collapsible section for secondary detail (estimates, diagnostics, advanced settings). Collapsed by default. */
export function Disclosure({ title, summary, defaultOpen = false, children, className, actions }: { title: React.ReactNode; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className={cx('rounded-lg border border-border bg-bg-elev', className)}>
      <div className="flex items-center gap-3 px-5 py-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">{title}</div>
            {summary && <div className="mt-0.5 truncate text-[13px] text-fg-muted">{summary}</div>}
          </div>
          <ChevronDown size={16} className={cx('shrink-0 text-fg-faint transition-transform', open && 'rotate-180')} />
        </button>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {open && <div className="border-t border-border p-5">{children}</div>}
    </section>
  );
}

export { TechnicalDetails } from './TechnicalDetails';
export type { TechnicalDetailsProps, TechnicalDetailsRow } from './TechnicalDetails';

/** Small exclusive choice (view mode, language). Prefer this over a row of look-alike buttons. */
export function Segmented<T extends string>({ value, onChange, options, className, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; disabled?: boolean }[]; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-md border border-border-strong bg-bg p-0.5 text-[13px]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx('rounded px-2.5 py-1 font-medium transition-colors disabled:opacity-40', value === o.value ? 'bg-bg-elev-2 text-fg' : 'text-fg-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
