'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Fleet Overview', icon: '\u229E' },
  { href: '/batch-jobs', label: 'Batch Jobs', icon: '\u2630' },
  { href: '/experiments', label: 'Experiments', icon: '\u25C8' },
];

export default function Sidebar({ dataSource }: { dataSource: string }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navContent = (
    <>
      <div className="px-5 py-5 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight">MLOps Dashboard</h1>
          <p className="text-xs text-gray-400 mt-1">IsaacLab Fleet Monitor</p>
        </div>
        <button
          className="md:hidden text-gray-400 hover:text-white p-1"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        >
          &#x2715;
        </button>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto" aria-label="Main navigation">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-5 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? 'bg-gray-700/60 text-aws-orange border-l-[3px] border-aws-orange'
                  : 'text-gray-300 hover:bg-gray-700/30 hover:text-white border-l-[3px] border-transparent'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="text-base" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-gray-700">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${dataSource === 'aws' ? 'bg-green-500' : dataSource === 'mock' ? 'bg-yellow-500' : 'bg-gray-500 animate-pulse'}`}
            aria-hidden="true"
          />
          <span className="text-gray-400">
            {dataSource === 'aws' ? 'Live (AWS)' : dataSource === 'mock' ? 'Mock Data' : 'Connecting...'}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-2">physical-ai-on-aws</p>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        className="fixed top-4 left-4 z-20 md:hidden bg-aws-dark text-white p-2 rounded-lg shadow-lg"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation menu"
      >
        &#x2630;
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile sidebar (slide drawer) */}
      <aside
        className={`fixed left-0 top-0 h-screen w-60 bg-aws-dark text-white flex flex-col z-30 md:hidden transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {navContent}
      </aside>

      {/* Desktop sidebar (always visible) */}
      <aside className="hidden md:flex fixed left-0 top-0 h-screen w-60 bg-aws-dark text-white flex-col z-10">
        {navContent}
      </aside>
    </>
  );
}
