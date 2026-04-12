'use client';

import DashboardShell from './DashboardShell';
import FleetSummaryCards from '@/components/FleetSummaryCards';
import RegionFilter from '@/components/RegionFilter';
import WorkerTable from '@/components/WorkerTable';
import DdpTopologyView from '@/components/DdpTopologyView';

function SkeletonCards() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="bg-white rounded-lg shadow-sm border-l-4 border-gray-200 p-5 animate-pulse">
          <div className="h-4 w-20 bg-gray-200 rounded mb-3" />
          <div className="h-7 w-12 bg-gray-200 rounded mb-2" />
          <div className="h-3 w-16 bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden animate-pulse">
      <div className="h-10 bg-gray-50 border-b border-gray-200" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-gray-100">
          <div className="h-6 w-16 bg-gray-200 rounded-full" />
          <div className="h-4 w-24 bg-gray-200 rounded" />
          <div className="h-4 w-32 bg-gray-200 rounded" />
          <div className="h-4 w-20 bg-gray-100 rounded" />
          <div className="h-4 w-16 bg-gray-100 rounded" />
          <div className="flex-1" />
          <div className="h-2 w-16 bg-gray-200 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  return (
    <DashboardShell>
      {(ctx) => {
        const isLoading = ctx.dataSource === 'loading';

        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Fleet Overview</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Monitoring {ctx.summary.total} worker instances across {ctx.regions.length} region{ctx.regions.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400">
                  Source: {ctx.dataSource === 'aws' ? 'AWS (Live)' : ctx.dataSource === 'mock' ? 'Mock Data' : '...'}
                </span>
                <span className="text-xs text-gray-400">Auto-refresh: 30s</span>
              </div>
            </div>

            {isLoading ? (
              <>
                <SkeletonCards />
                <SkeletonTable />
              </>
            ) : (
              <>
                <FleetSummaryCards summary={ctx.summary} />
                <DdpTopologyView workers={ctx.workers} experiments={ctx.experiments} />

                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-800">Worker Instances</h3>
                  <RegionFilter regions={ctx.regions} selected={ctx.selectedRegion} onChange={ctx.setSelectedRegion} />
                </div>

                <WorkerTable workers={ctx.filteredWorkers} />
              </>
            )}
          </div>
        );
      }}
    </DashboardShell>
  );
}
