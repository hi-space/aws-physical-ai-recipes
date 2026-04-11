import { useState } from 'react';
import type { TrainingMetrics } from '../types/worker';

type MetricTab = 'reward' | 'policyLoss' | 'valueLoss' | 'episodeLength';

const tabs: { key: MetricTab; label: string; color: string }[] = [
  { key: 'reward', label: 'Reward', color: '#22c55e' },
  { key: 'policyLoss', label: 'Policy Loss', color: '#ef4444' },
  { key: 'valueLoss', label: 'Value Loss', color: '#f59e0b' },
  { key: 'episodeLength', label: 'Episode Length', color: '#3b82f6' },
];

interface Props {
  metrics: TrainingMetrics | undefined;
}

export default function TrainingMetricsChart({ metrics }: Props) {
  const [activeTab, setActiveTab] = useState<MetricTab>('reward');

  if (!metrics) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Training Metrics</h3>
        <div className="flex items-center justify-center h-[200px] text-gray-400 text-sm">
          No training metrics available
        </div>
      </div>
    );
  }

  const dataMap: Record<MetricTab, number[]> = {
    reward: metrics.rewards,
    policyLoss: metrics.policyLoss,
    valueLoss: metrics.valueLoss,
    episodeLength: metrics.episodeLengths,
  };

  const data = dataMap[activeTab];
  const steps = metrics.steps;
  const currentTab = tabs.find((t) => t.key === activeTab)!;

  // SVG chart dimensions
  const W = 560;
  const H = 180;
  const padL = 50;
  const padR = 15;
  const padT = 10;
  const padB = 25;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  const toX = (i: number) => padL + (i / (data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - ((v - minVal) / range) * chartH;

  const pathD = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  // Y-axis labels
  const yLabels = [minVal, minVal + range * 0.5, maxVal];

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">Training Metrics</h3>
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-white'
                  : 'text-gray-500 bg-gray-100 hover:bg-gray-200'
              }`}
              style={activeTab === tab.key ? { backgroundColor: tab.color } : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {yLabels.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-gray-400" style={{ fontSize: '10px' }}>
                {v >= 100 ? v.toFixed(0) : v.toFixed(2)}
              </text>
            </g>
          );
        })}
        {/* X-axis labels */}
        {[0, Math.floor(steps.length / 2), steps.length - 1].map((idx) => (
          <text key={idx} x={toX(idx)} y={H - 4} textAnchor="middle" className="fill-gray-400" style={{ fontSize: '10px' }}>
            {steps[idx]}
          </text>
        ))}
        {/* Data line */}
        <path d={pathD} fill="none" stroke={currentTab.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {/* Area fill */}
        <path
          d={`${pathD} L${toX(data.length - 1).toFixed(1)},${(padT + chartH).toFixed(1)} L${padL},${(padT + chartH).toFixed(1)} Z`}
          fill={currentTab.color}
          opacity={0.08}
        />
      </svg>
      <p className="text-xs text-gray-400 text-center mt-1">Training Steps</p>
    </div>
  );
}
