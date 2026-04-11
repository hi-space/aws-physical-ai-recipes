'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Fleet Overview', icon: '\u229E' },
  { href: '/experiments', label: 'Experiments', icon: '\u25C8' },
];

export default function Sidebar({ dataSource }: { dataSource: string }) {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-aws-dark text-white flex flex-col z-10">
      <div className="px-5 py-5 border-b border-gray-700">
        <h1 className="text-lg font-bold tracking-tight">MLOps Dashboard</h1>
        <p className="text-xs text-gray-400 mt-1">IsaacLab Fleet Monitor</p>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-5 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? 'bg-gray-700/60 text-aws-orange border-l-[3px] border-aws-orange'
                  : 'text-gray-300 hover:bg-gray-700/30 hover:text-white border-l-[3px] border-transparent'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-gray-700">
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${dataSource === 'aws' ? 'bg-green-500' : dataSource === 'mock' ? 'bg-yellow-500' : 'bg-gray-500 animate-pulse'}`} />
          <span className="text-gray-400">
            {dataSource === 'aws' ? 'Live (AWS)' : dataSource === 'mock' ? 'Mock Data' : 'Connecting...'}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-2">physical-ai-on-aws</p>
      </div>
    </aside>
  );
}
