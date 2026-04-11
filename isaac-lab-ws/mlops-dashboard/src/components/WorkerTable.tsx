import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Worker } from '../types/worker';
import StatusBadge from './StatusBadge';

type SortField = 'status' | 'instanceId' | 'taskName' | 'instanceType' | 'region' | 'gpuUtilization' | 'ddpRank' | 'currentStep';
type SortDir = 'asc' | 'desc';

export default function WorkerTable({ workers }: { workers: Worker[] }) {
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>('ddpRank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sorted = [...workers].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    const cmp = typeof av === 'number' ? (av as number) - (bv as number) : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <th
      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortField === field && <span>{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  );

  const gpuColor = (util: number) => {
    if (util >= 80) return 'bg-green-500';
    if (util >= 50) return 'bg-yellow-500';
    if (util > 0) return 'bg-red-500';
    return 'bg-gray-300';
  };

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortHeader field="status">Status</SortHeader>
              <SortHeader field="instanceId">Instance</SortHeader>
              <SortHeader field="taskName">Task</SortHeader>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Experiment</th>
              <SortHeader field="instanceType">Type</SortHeader>
              <SortHeader field="region">Region</SortHeader>
              <SortHeader field="gpuUtilization">GPU Util</SortHeader>
              <SortHeader field="ddpRank">DDP Rank</SortHeader>
              <SortHeader field="currentStep">Progress</SortHeader>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Reward</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((w) => {
              const pct = w.totalSteps > 0 ? Math.round((w.currentStep / w.totalSteps) * 100) : 0;
              return (
                <tr
                  key={w.id}
                  onClick={() => navigate(`/worker/${w.id}`)}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <StatusBadge status={w.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-sm text-gray-700">{w.instanceId.slice(0, 12)}...</td>
                  <td className="px-4 py-3 text-sm text-gray-800">{w.taskName}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{w.experimentName}</td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600">{w.instanceType}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{w.region}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${gpuColor(w.gpuUtilization)}`} style={{ width: `${w.gpuUtilization}%` }} />
                      </div>
                      <span className="text-sm text-gray-700 w-10 text-right">{w.gpuUtilization}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 text-center">
                    {w.ddpRank}/{w.ddpWorldSize}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 whitespace-nowrap">{w.currentStep}/{w.totalSteps}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-800">{w.currentReward > 0 ? w.currentReward.toFixed(1) : '-'}</td>
                  <td className="px-4 py-3">
                    <button className="text-xs text-blue-600 hover:text-blue-800 font-medium">View</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
