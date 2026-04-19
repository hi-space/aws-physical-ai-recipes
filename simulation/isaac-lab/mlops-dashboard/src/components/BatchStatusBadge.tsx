'use client';

const statusConfig: Record<string, { bg: string; text: string; dot: string; pulse?: boolean }> = {
  RUNNING: { bg: 'bg-green-100', text: 'text-green-800', dot: 'bg-green-500', pulse: true },
  STARTING: { bg: 'bg-blue-100', text: 'text-blue-800', dot: 'bg-blue-500', pulse: true },
  SUBMITTED: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-800', dot: 'bg-yellow-500' },
  RUNNABLE: { bg: 'bg-indigo-100', text: 'text-indigo-800', dot: 'bg-indigo-500' },
  SUCCEEDED: { bg: 'bg-emerald-100', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-800', dot: 'bg-red-500' },
};

const fallback = { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' };

export default function BatchStatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] || fallback;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span className={`w-2 h-2 rounded-full ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}
