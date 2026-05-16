'use client';

import { memo } from 'react';
import type { FleetSummary } from '@/types/worker';

function Card({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color: string }) {
  return (
    <div className={`bg-white rounded-lg shadow-sm border-l-4 ${color} p-5`}>
      <p className="text-sm text-gray-500 font-medium">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

export default memo(function FleetSummaryCards({ summary }: { summary: FleetSummary }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card label="Total Workers" value={summary.total} sub={`${summary.pending} pending`} color="border-blue-500" />
      <Card label="Running" value={summary.running} sub={`${summary.failed} failed`} color="border-green-500" />
      <Card label="Total GPUs" value={summary.totalGpus} sub="allocated" color="border-amber-500" />
      <Card label="Best Reward" value={summary.bestReward} sub="current best" color="border-aws-orange" />
    </div>
  );
});
