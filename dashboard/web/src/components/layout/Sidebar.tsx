'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Boxes, Cpu, Database, FlaskConical, GitBranch, HardDrive, Layers, LayoutDashboard, ListTree, MonitorPlay, Radio, Settings, Workflow } from 'lucide-react';
import { classNames as cx } from '@/lib/format';
import { useMe } from '@/lib/api-client';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { section: 'Run' },
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/jobs', label: 'Jobs & Pods', icon: ListTree, feature: 'eks' },
  { href: '/pipelines', label: 'SageMaker Pipelines', icon: GitBranch, feature: 'pipeline' },
  { href: '/sessions', label: 'Sessions (DCV / TensorBoard)', icon: MonitorPlay },
  { section: 'Data' },
  { href: '/datasets', label: 'Datasets', icon: Database },
  { href: '/models', label: 'Models', icon: Boxes },
  { href: '/experiments', label: 'Experiments (MLflow)', icon: FlaskConical, feature: 'mlflow' },
  { href: '/storage', label: 'Storage (S3 / FSx)', icon: HardDrive },
  { section: 'Infrastructure' },
  { href: '/compute', label: 'Compute', icon: Cpu },
  { href: '/queues', label: 'Queues & Quotas', icon: Layers, feature: 'eks' },
  { href: '/metrics', label: 'Metrics', icon: Activity, feature: 'amp' },
  { href: '/edge', label: 'Edge (Greengrass)', icon: Radio },
  { section: 'System' },
  { href: '/admin', label: 'Admin', icon: Settings, role: 'admin' },
] as const;

export function Sidebar() {
  const path = usePathname();
  const { data: me } = useMe();
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-bg-elev">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-accent-strong text-[11px] font-bold text-white">PAI</div>
        <div>
          <div className="text-[13px] font-semibold leading-tight">Physical AI</div>
          <div className="text-[10px] uppercase tracking-wider text-fg-faint">Dashboard</div>
        </div>
      </div>
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((n, i) => {
          if ('section' in n) return <div key={i} className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wider text-fg-faint">{n.section}</div>;
          const disabled = ('feature' in n && me && !me.features[n.feature as keyof typeof me.features]) || ('role' in n && me && me.role !== 'admin');
          const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cx('my-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors', active ? 'bg-accent/10 text-fg' : 'text-fg-muted hover:bg-bg-elev-2 hover:text-fg', disabled && 'opacity-40')}
              title={disabled ? 'Not configured in this deployment' : undefined}
            >
              <Icon size={15} className={active ? 'text-accent' : ''} />
              <span className="truncate">{n.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border px-4 py-2.5 text-[11px] text-fg-faint">
        {me ? (
          <>
            <div className="truncate text-fg-muted">{me.email || me.user}</div>
            <div className="flex items-center justify-between">
              <span className="capitalize">{me.role}</span>
              <span className="num">{me.region}</span>
            </div>
          </>
        ) : (
          <span>…</span>
        )}
      </div>
    </aside>
  );
}
