'use client';

import { useState } from 'react';
import DashboardShell from '@/app/DashboardShell';
import StatusBadge from '@/components/StatusBadge';

const expColors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function ExperimentsPage() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <DashboardShell>
      {(ctx) => {
        // Initialize selections on first render with data
        if (!initialized && ctx.experiments.length > 0) {
          setSelectedIds(ctx.experiments.map((e) => e.id));
          setInitialized(true);
        }

        const selectedExps = ctx.experiments.filter((e) => selectedIds.includes(e.id));
        const allParamKeys = Array.from(
          new Set(selectedExps.flatMap((e) => Object.keys(e.hyperparams))),
        ).sort();

        const W = 600, H = 200, padL = 50, padR = 15, padT = 15, padB = 30;
        const chartW = W - padL - padR, chartH = H - padT - padB;

        const allMetrics = ctx.trainingMetrics.filter((m) => {
          const worker = ctx.workers.find((w) => w.id === m.workerId);
          return worker && selectedExps.some((e) => e.workerIds.includes(worker.id));
        });

        const allRewards = allMetrics.flatMap((m) => m.rewards);
        const maxReward = allRewards.length > 0 ? Math.max(...allRewards) : 1;
        const minReward = allRewards.length > 0 ? Math.min(...allRewards) : 0;
        const rewardRange = maxReward - minReward || 1;

        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Experiments</h2>
              <p className="text-sm text-gray-500 mt-1">Compare training runs and hyperparameters</p>
            </div>

            {/* Experiment Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {ctx.experiments.length === 0 && (
                <div className="col-span-full bg-white rounded-lg shadow-sm p-8 text-center text-sm text-gray-400">
                  No experiments found
                </div>
              )}
              {ctx.experiments.map((exp, idx) => {
                const isSelected = selectedIds.includes(exp.id);
                const pct = exp.totalSteps > 0 ? Math.round((exp.currentStep / exp.totalSteps) * 100) : 0;
                const expWorkers = ctx.workers.filter((w) => exp.workerIds.includes(w.id));

                return (
                  <div key={exp.id} onClick={() => toggleSelect(exp.id)}
                    className={`bg-white rounded-lg shadow-sm p-5 cursor-pointer transition-all border-2 ${isSelected ? 'border-blue-500 ring-1 ring-blue-200' : 'border-transparent hover:border-gray-200'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: expColors[idx % expColors.length] }} />
                        <h3 className="font-semibold text-gray-800">{exp.name}</h3>
                      </div>
                      <StatusBadge status={exp.status} />
                    </div>
                    <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                      <div><dt className="text-xs text-gray-400">Algorithm</dt><dd className="font-medium text-gray-700">{exp.algorithm}</dd></div>
                      <div><dt className="text-xs text-gray-400">Workers</dt><dd className="font-medium text-gray-700">{expWorkers.length}</dd></div>
                      <div><dt className="text-xs text-gray-400">Task</dt><dd className="text-gray-600 text-xs truncate">{exp.taskName}</dd></div>
                      <div><dt className="text-xs text-gray-400">Best Reward</dt><dd className="font-medium text-gray-700">{exp.bestReward.toFixed(1)}</dd></div>
                    </dl>
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-gray-400 mb-1"><span>Progress</span><span>{exp.currentStep}/{exp.totalSteps}</span></div>
                      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Reward Comparison Chart */}
            {allMetrics.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Reward Comparison (Overlay)</h3>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
                  {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                    const v = minReward + rewardRange * frac;
                    const y = padT + chartH - frac * chartH;
                    return (<g key={frac}><line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#f3f4f6" strokeWidth={1} />
                      <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-gray-400" style={{ fontSize: '10px' }}>{v.toFixed(1)}</text></g>);
                  })}
                  {selectedExps.map((exp) => {
                    const m = allMetrics.find((met) => exp.workerIds.includes(met.workerId));
                    if (!m) return null;
                    const toX = (i: number) => padL + (i / (m.rewards.length - 1)) * chartW;
                    const toY = (v: number) => padT + chartH - ((v - minReward) / rewardRange) * chartH;
                    const d = m.rewards.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
                    return <path key={exp.id} d={d} fill="none" stroke={expColors[ctx.experiments.indexOf(exp) % expColors.length]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />;
                  })}
                </svg>
                <div className="flex justify-center gap-4 mt-2">
                  {selectedExps.map((exp) => (
                    <span key={exp.id} className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="w-3 h-0.5 rounded" style={{ backgroundColor: expColors[ctx.experiments.indexOf(exp) % expColors.length] }} />{exp.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Hyperparameter Comparison Table */}
            {selectedExps.length > 1 && (
              <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700">Hyperparameter Comparison</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Parameter</th>
                        {selectedExps.map((exp) => (
                          <th key={exp.id} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{exp.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {allParamKeys.map((key) => {
                        const values = selectedExps.map((e) => e.hyperparams[key]);
                        const allSame = values.every((v) => v === values[0]);
                        return (
                          <tr key={key} className={allSame ? '' : 'bg-yellow-50'}>
                            <td className="px-4 py-2 text-sm font-mono text-gray-600">{key}</td>
                            {values.map((v, i) => (
                              <td key={i} className={`px-4 py-2 text-sm font-mono ${allSame ? 'text-gray-500' : 'text-gray-900 font-semibold'}`}>
                                {v !== undefined ? String(v) : '-'}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      }}
    </DashboardShell>
  );
}
