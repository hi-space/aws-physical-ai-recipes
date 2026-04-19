'use client';

import { useState } from 'react';
import type { BatchJob } from '@/types/worker';
import BatchStatusBadge from './BatchStatusBadge';

type SortField = 'status' | 'jobName' | 'jobQueue' | 'createdAt' | 'startedAt';
type SortDir = 'asc' | 'desc';

export default function BatchJobsTable({ jobs, queueFilter, statusFilter, onQueueChange, onStatusChange }: {
  jobs: BatchJob[];
  queueFilter: string;
  statusFilter: string;
  onQueueChange: (q: string) => void;
  onStatusChange: (s: string) => void;
}) {
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const filtered = jobs
    .filter((j) => queueFilter === 'all' || j.jobQueue === queueFilter)
    .filter((j) => statusFilter === 'all' || j.status === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    const cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const queues = Array.from(new Set(jobs.map((j) => j.jobQueue))).sort();
  const statuses = Array.from(new Set(jobs.map((j) => j.status))).sort();

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <th
      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortField === field && <span>{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
      </span>
    </th>
  );

  const formatTime = (iso: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (start: string, stop: string) => {
    if (!start) return '-';
    const s = new Date(start).getTime();
    const e = stop ? new Date(stop).getTime() : Date.now();
    const diffMin = Math.floor((e - s) / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return `${h}h ${m}m`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Queue:</span>
          <div className="flex gap-1">
            <button
              onClick={() => onQueueChange('all')}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${queueFilter === 'all' ? 'bg-aws-dark text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
            >
              All
            </button>
            {queues.map((q) => (
              <button
                key={q}
                onClick={() => onQueueChange(q)}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${queueFilter === q ? 'bg-aws-dark text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Status:</span>
          <div className="flex gap-1">
            <button
              onClick={() => onStatusChange('all')}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${statusFilter === 'all' ? 'bg-aws-dark text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
            >
              All
            </button>
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => onStatusChange(s)}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${statusFilter === s ? 'bg-aws-dark text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <SortHeader field="status">Status</SortHeader>
                <SortHeader field="jobName">Job Name</SortHeader>
                <SortHeader field="jobQueue">Queue</SortHeader>
                <SortHeader field="createdAt">Created</SortHeader>
                <SortHeader field="startedAt">Started</SortHeader>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Duration</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Container</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Resources</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-400">
                    No batch jobs found
                  </td>
                </tr>
              ) : (
                sorted.map((job) => (
                  <tr key={job.jobId} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3"><BatchStatusBadge status={job.status} /></td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-800">{job.jobName}</div>
                      <div className="text-xs text-gray-400 font-mono">{job.jobId.slice(0, 12)}...</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{job.jobQueue}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatTime(job.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatTime(job.startedAt)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatDuration(job.startedAt, job.stoppedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-gray-500 font-mono max-w-[200px] truncate" title={job.container.image}>
                        {job.container.image.split('/').pop()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 text-xs text-gray-600">
                        {job.container.gpus > 0 && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-700 rounded">
                            GPU {job.container.gpus}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded">
                          vCPU {job.container.vcpus}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-50 text-gray-600 rounded">
                          {(job.container.memory / 1024).toFixed(0)}GB
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
