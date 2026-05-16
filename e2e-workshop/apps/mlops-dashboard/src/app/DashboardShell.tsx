'use client';

import { useWorkers } from '@/hooks/useWorkers';
import Sidebar from '@/components/Sidebar';

export default function DashboardShell({ children }: { children: (ctx: ReturnType<typeof useWorkers>) => React.ReactNode }) {
  const ctx = useWorkers();

  return (
    <div className="flex min-h-screen">
      <Sidebar dataSource={ctx.dataSource} />
      <main className="md:ml-60 flex-1 p-6 pt-16 md:pt-6 bg-gray-50 min-h-screen">
        {ctx.error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            API Error: {ctx.error}
          </div>
        )}
        {children(ctx)}
      </main>
    </div>
  );
}
