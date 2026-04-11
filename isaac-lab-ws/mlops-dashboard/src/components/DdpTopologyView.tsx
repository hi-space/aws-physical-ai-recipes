'use client';

import type { Worker, Experiment } from '@/types/worker';

const statusColor: Record<string, string> = {
  RUNNING: '#22c55e', PENDING: '#eab308', STOPPED: '#9ca3af', FAILED: '#ef4444',
};

export default function DdpTopologyView({ workers, experiments }: { workers: Worker[]; experiments: Experiment[] }) {
  const activeExperiments = experiments.filter((e) => e.status === 'RUNNING' || e.status === 'PENDING');

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">DDP Topology</h3>
      <div className="flex gap-8 flex-wrap">
        {activeExperiments.map((exp) => {
          const expWorkers = workers.filter((w) => exp.workerIds.includes(w.id));
          const svgWidth = Math.max(180, expWorkers.length * 80);
          return (
            <div key={exp.id} className="flex flex-col items-center">
              <div className="text-xs font-medium text-gray-500 mb-3">{exp.name} ({exp.algorithm})</div>
              <svg width={svgWidth} height={140} className="overflow-visible">
                {expWorkers.filter((w) => w.ddpRank === 0).map((master) => {
                  const cx = svgWidth / 2;
                  return (
                    <g key={master.id}>
                      {expWorkers.filter((w) => w.ddpRank !== 0).map((worker, i) => {
                        const wx = 40 + i * 80;
                        return <line key={worker.id} x1={cx} y1={45} x2={wx} y2={95} stroke="#d1d5db" strokeWidth={2} strokeDasharray={worker.status !== 'RUNNING' ? '4,4' : undefined} />;
                      })}
                      <circle cx={cx} cy={30} r={22} fill={statusColor[master.status]} opacity={0.15} stroke={statusColor[master.status]} strokeWidth={2} />
                      <circle cx={cx} cy={30} r={14} fill={statusColor[master.status]} opacity={0.3} />
                      <text x={cx} y={34} textAnchor="middle" className="text-xs font-bold fill-gray-800">R0</text>
                      <rect x={cx - 15} y={56} width={30} height={4} rx={2} fill="#e5e7eb" />
                      <rect x={cx - 15} y={56} width={30 * master.gpuUtilization / 100} height={4} rx={2} fill={statusColor[master.status]} />
                      <text x={cx} y={72} textAnchor="middle" className="fill-gray-400" style={{ fontSize: '9px' }}>{master.gpuUtilization}%</text>
                    </g>
                  );
                })}
                {expWorkers.filter((w) => w.ddpRank !== 0).map((worker, i) => {
                  const cx = 40 + i * 80;
                  return (
                    <g key={worker.id}>
                      <circle cx={cx} cy={100} r={18} fill={statusColor[worker.status]} opacity={0.15} stroke={statusColor[worker.status]} strokeWidth={2} />
                      <circle cx={cx} cy={100} r={11} fill={statusColor[worker.status]} opacity={0.3} />
                      <text x={cx} y={104} textAnchor="middle" className="text-xs font-bold fill-gray-800">R{worker.ddpRank}</text>
                      <rect x={cx - 12} y={122} width={24} height={3} rx={1.5} fill="#e5e7eb" />
                      <rect x={cx - 12} y={122} width={24 * worker.gpuUtilization / 100} height={3} rx={1.5} fill={statusColor[worker.status]} />
                      <text x={cx} y={137} textAnchor="middle" className="fill-gray-400" style={{ fontSize: '9px' }}>{worker.gpuUtilization}%</text>
                    </g>
                  );
                })}
                {expWorkers.length === 1 && expWorkers.map((w) => (
                  <g key={w.id}>
                    <circle cx={90} cy={60} r={24} fill={statusColor[w.status]} opacity={0.15} stroke={statusColor[w.status]} strokeWidth={2} />
                    <circle cx={90} cy={60} r={16} fill={statusColor[w.status]} opacity={0.3} />
                    <text x={90} y={64} textAnchor="middle" className="text-xs font-bold fill-gray-800">R0</text>
                    <rect x={75} y={90} width={30} height={4} rx={2} fill="#e5e7eb" />
                    <rect x={75} y={90} width={30 * w.gpuUtilization / 100} height={4} rx={2} fill={statusColor[w.status]} />
                    <text x={90} y={106} textAnchor="middle" className="fill-gray-400" style={{ fontSize: '9px' }}>{w.gpuUtilization}%</text>
                  </g>
                ))}
              </svg>
              <div className="text-xs text-gray-400 mt-1">
                World Size: {expWorkers[0]?.ddpWorldSize ?? '?'} &middot; {expWorkers[0]?.ddpBackend ?? 'nccl'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
