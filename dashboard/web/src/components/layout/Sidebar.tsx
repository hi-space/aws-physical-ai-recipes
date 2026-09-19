'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Boxes, Cpu, Database, FlaskConical, GitBranch, HardDrive, Layers, LayoutDashboard, ListTree, MonitorPlay, Radio, Server, Settings, Workflow, type LucideIcon } from 'lucide-react';
import { classNames as cx } from '@/lib/format';
import { api, useMe, type Me } from '@/lib/api-client';
import { LOCALES, LOCALE_SHORT_LABELS, useLocale, useSetLocale, useT, type MessageKey } from '@/lib/i18n';
import { ProjectSwitcher } from './ProjectSwitcher';

type Feature = keyof Me['features'];
interface NavItem { href: string; key: MessageKey<'nav'>; icon: LucideIcon; feature?: Feature; admin?: boolean }
interface NavGroup { key?: MessageKey<'nav'>; items: NavItem[] }

/**
 * Four groups: home, the research loop (data → run → results), the cluster behind it, and settings.
 * Items whose backing stack is not deployed are hidden instead of greyed out; admin-only pages hide for other roles.
 */
const NAV: NavGroup[] = [
  { items: [{ href: '/', key: 'overview', icon: LayoutDashboard }] },
  {
    key: 'groupResearch',
    items: [
      { href: '/workflows', key: 'workflows', icon: Workflow },
      { href: '/datasets', key: 'datasets', icon: Database },
      { href: '/models', key: 'models', icon: Boxes },
      { href: '/experiments', key: 'experiments', icon: FlaskConical, feature: 'mlflow' },
      { href: '/pipelines', key: 'pipelines', icon: GitBranch, feature: 'pipeline' },
      { href: '/sessions', key: 'sessions', icon: MonitorPlay, feature: 'sessions' },
    ],
  },
  {
    key: 'groupCluster',
    items: [
      { href: '/compute', key: 'compute', icon: Cpu },
      { href: '/resources', key: 'resources', icon: Server },
      { href: '/queues', key: 'queues', icon: Layers, feature: 'eks' },
      { href: '/jobs', key: 'jobs', icon: ListTree, feature: 'eks' },
      { href: '/metrics', key: 'metrics', icon: Activity, feature: 'amp' },
      { href: '/storage', key: 'storage', icon: HardDrive },
      { href: '/usage', key: 'usage', icon: Activity },
    ],
  },
  {
    key: 'groupSettings',
    items: [
      { href: '/projects', key: 'projects', icon: Layers },
      { href: '/access', key: 'access', icon: Settings },
      { href: '/image-profiles', key: 'imageProfiles', icon: Boxes },
      { href: '/edge', key: 'edge', icon: Radio, feature: 'edge' },
      { href: '/webhooks', key: 'webhooks', icon: GitBranch },
      { href: '/builds', key: 'builds', icon: Boxes, admin: true },
      { href: '/backends', key: 'backends', icon: Layers, admin: true },
      { href: '/admin', key: 'admin', icon: Settings, admin: true },
    ],
  },
];

function visible(item: NavItem, me: Me | undefined): boolean {
  if (item.admin && me?.role !== 'admin') return false;
  if (item.feature && me && me.features && me.features[item.feature] === false) return false;
  return true;
}

export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const tc = useT('common');
  return (
    <div role="radiogroup" aria-label={tc('language')} className={cx('inline-flex rounded-md border border-border-strong bg-bg p-0.5 text-xs', className)}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={locale === l}
          onClick={() => setLocale(l)}
          className={cx('rounded px-2 py-1 font-medium transition-colors', locale === l ? 'bg-bg-elev-2 text-fg' : 'text-fg-faint hover:text-fg')}
        >
          {LOCALE_SHORT_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

export function Sidebar() {
  const path = usePathname();
  const { data: me } = useMe();
  const t = useT('nav');
  const tc = useT('common');
  const roleLabel: Record<Me['role'], string> = { admin: tc('roleAdmin'), researcher: tc('roleResearcher'), viewer: tc('roleViewer') };
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-border bg-bg-elev">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-accent-strong text-xs font-bold text-white">PAI</div>
        <div>
          <div className="text-sm font-semibold leading-tight">{t('brand')}</div>
          <div className="text-[11px] uppercase tracking-wider text-fg-faint">{t('brandSub')}</div>
        </div>
      </div>
      <ProjectSwitcher />
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((group, gi) => {
          const items = group.items.filter((item) => visible(item, me));
          if (!items.length) return null;
          return (
            <div key={group.key ?? gi}>
              {group.key && <div className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-fg-faint">{t(group.key)}</div>}
              {items.map((item) => {
                const active = item.href === '/' ? path === '/' : path.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx('my-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors', active ? 'bg-accent/10 font-medium text-fg' : 'text-fg-muted hover:bg-bg-elev-2 hover:text-fg')}
                  >
                    <Icon size={16} className={cx('shrink-0', active && 'text-accent')} />
                    <span className="truncate">{t(item.key)}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-fg-faint">
        <div className="flex items-center justify-between gap-2">
          <LanguageToggle />
          {me && <span className="num">{me.region}</span>}
        </div>
        {me ? (
          <>
            <div className="truncate text-[13px] text-fg-muted" title={me.email || me.user}>{me.email || me.user}</div>
            <div className="flex items-center justify-between">
              <span>{roleLabel[me.role] ?? me.role}</span>
              <button className="text-xs text-fg-muted hover:text-fg" onClick={async () => {
                try { await api('/api/auth/logout', { method: 'POST' }); }
                finally { window.location.href = '/api/logout'; }
              }}>{tc('logout')}</button>
            </div>
          </>
        ) : (
          <span>…</span>
        )}
      </div>
    </aside>
  );
}
