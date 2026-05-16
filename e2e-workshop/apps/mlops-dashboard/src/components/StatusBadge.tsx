'use client';

import type { WorkerStatus } from '@/types/worker';

const statusConfig: Record<WorkerStatus, { bg: string; text: string; dot: string; pulse?: boolean }> = {
  RUNNING: { bg: 'bg-green-100', text: 'text-green-800', dot: 'bg-green-500', pulse: true },
  PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-800', dot: 'bg-yellow-500' },
  STOPPED: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-800', dot: 'bg-red-500' },
};

export default function StatusBadge({ status }: { status: WorkerStatus }) {
  const cfg = statusConfig[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span className={`w-2 h-2 rounded-full ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}
