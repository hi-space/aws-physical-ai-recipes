import { useState, useEffect, useRef } from 'react';
import type { Worker } from '../types/worker';

interface DataPoint {
  time: number;
  gpuUtil: number;
  gpuMem: number;
  gpuTemp: number;
}

export default function GpuTimelineChart({ worker }: { worker: Worker }) {
  const [history, setHistory] = useState<DataPoint[]>([]);
  const startTime = useRef(Date.now());

  useEffect(() => {
    setHistory((prev) => {
      const point: DataPoint = {
        time: (Date.now() - startTime.current) / 1000,
        gpuUtil: worker.gpuUtilization,
        gpuMem: worker.gpuMemoryUtilization,
        gpuTemp: worker.gpuTemperature,
      };
      const next = [...prev, point];
      return next.length > 60 ? next.slice(-60) : next;
    });
  }, [worker.gpuUtilization, worker.gpuMemoryUtilization, worker.gpuTemperature]);

  const W = 560;
  const H = 160;
  const padL = 40;
  const padR = 15;
  const padT = 10;
  const padB = 25;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  if (history.length < 2) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">GPU Timeline</h3>
        <div className="flex items-center justify-center h-[120px] text-gray-400 text-sm">
          Collecting data...
        </div>
      </div>
    );
  }

  const minTime = history[0].time;
  const maxTime = history[history.length - 1].time;
  const timeRange = maxTime - minTime || 1;

  const toX = (t: number) => padL + ((t - minTime) / timeRange) * chartW;
  const toY = (v: number) => padT + chartH - (v / 100) * chartH;

  const makePath = (key: keyof Omit<DataPoint, 'time'>) =>
    history.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.time).toFixed(1)},${toY(p[key]).toFixed(1)}`).join(' ');

  const series = [
    { key: 'gpuUtil' as const, label: 'GPU Util', color: '#8b5cf6' },
    { key: 'gpuMem' as const, label: 'GPU Mem', color: '#6366f1' },
    { key: 'gpuTemp' as const, label: 'GPU Temp', color: '#ef4444' },
  ];

  const thermalY = toY(85);

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">GPU Timeline</h3>
        <div className="flex gap-3">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1 text-xs text-gray-500">
              <span className="w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#f3f4f6" strokeWidth={1} />
            <text x={padL - 5} y={toY(v) + 3} textAnchor="end" className="fill-gray-400" style={{ fontSize: '9px' }}>
              {v}
            </text>
          </g>
        ))}
        {/* Thermal throttle threshold */}
        <line x1={padL} y1={thermalY} x2={W - padR} y2={thermalY} stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" opacity={0.5} />
        <text x={W - padR + 2} y={thermalY + 3} className="fill-red-400" style={{ fontSize: '8px' }}>
          85°C
        </text>
        {/* Data lines */}
        {series.map((s) => (
          <path key={s.key} d={makePath(s.key)} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
      <p className="text-xs text-gray-400 text-center mt-1">Time (seconds)</p>
    </div>
  );
}
