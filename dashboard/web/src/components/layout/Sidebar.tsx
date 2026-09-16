'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Boxes, Cpu, Database, FlaskConical, GitBranch, HardDrive, Layers, LayoutDashboard, ListTree, MonitorPlay, Radio, Settings, Workflow } from 'lucide-react';
import { classNames as cx } from '@/lib/format';
import { api, useMe } from '@/lib/api-client';
import { ProjectSwitcher } from './ProjectSwitcher';

const NAV = [
  { href: '/', label: '연구 현황', icon: LayoutDashboard },
  { section: '실행' },
  { href: '/workflows', label: '파이프라인 실행', icon: Workflow },
  { href: '/jobs', label: '작업과 실행 환경', icon: ListTree, feature: 'eks' },
  { href: '/pipelines', label: 'SageMaker 학습', icon: GitBranch, feature: 'pipeline' },
  { href: '/sessions', label: '시뮬레이션·개발', icon: MonitorPlay },
  { section: '연구 자산' },
  { href: '/datasets', label: '데이터셋', icon: Database },
  { href: '/models', label: '모델·평가', icon: Boxes },
  { href: '/experiments', label: '실험 비교', icon: FlaskConical, feature: 'mlflow' },
  { href: '/storage', label: '파일 저장소', icon: HardDrive },
  { section: '자원' },
  { href: '/compute', label: '컴퓨트', icon: Cpu },
  { href: '/queues', label: '대기열·할당량', icon: Layers, feature: 'eks' },
  { href: '/metrics', label: '메트릭', icon: Activity, feature: 'amp' },
  { href: '/usage', label: '사용량·예상 비용', icon: Activity },
  { href: '/edge', label: '디바이스·배포', icon: Radio },
  { section: '관리' },
  { href: '/projects', label: '프로젝트·구성원', icon: Layers },
  { href: '/access', label: '자격증명·API 토큰', icon: Settings },
  { href: '/image-profiles', label: '이미지·실행 환경', icon: Boxes },
  { href: '/backends', label: '백엔드 연결', icon: Layers, role: 'admin' },
  { href: '/webhooks', label: '자동화·웹훅', icon: GitBranch },
  { href: '/builds', label: '환경 빌드·동기화', icon: Boxes, role: 'admin' },
  { href: '/admin', label: '플랫폼 설정', icon: Settings, role: 'admin' },
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
      <ProjectSwitcher />
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((n, i) => {
          if ('section' in n) return <div key={i} className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wider text-fg-faint">{n.section}</div>;
          if (n.href === '/backends' && me?.role !== 'admin') return null;
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
            <button className="mt-2 text-xs text-fg-muted hover:text-fg" onClick={async () => {
              try { await api('/api/auth/logout', { method: 'POST' }); }
              finally { window.location.href = '/api/logout'; }
            }}>로그아웃</button>
          </>
        ) : (
          <span>…</span>
        )}
      </div>
    </aside>
  );
}
