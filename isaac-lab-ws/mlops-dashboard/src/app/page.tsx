'use client';

import DashboardShell from './DashboardShell';
import FleetSummaryCards from '@/components/FleetSummaryCards';
import RegionFilter from '@/components/RegionFilter';
import WorkerTable from '@/components/WorkerTable';
import DdpTopologyView from '@/components/DdpTopologyView';

export default function Home() {
  return (
    <DashboardShell>
      {(ctx) => (
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
              <span className="text-xs text-gray-400">Auto-refresh: 3s</span>
            </div>
          </div>

          <FleetSummaryCards summary={ctx.summary} />
          <DdpTopologyView workers={ctx.workers} experiments={ctx.experiments} />

          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-800">Worker Instances</h3>
            <RegionFilter regions={ctx.regions} selected={ctx.selectedRegion} onChange={ctx.setSelectedRegion} />
          </div>

          <WorkerTable workers={ctx.filteredWorkers} />
        </div>
      )}
    </DashboardShell>
  );
}
