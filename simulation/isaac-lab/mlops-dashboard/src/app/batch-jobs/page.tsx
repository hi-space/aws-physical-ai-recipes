'use client';

import { useState } from 'react';
import DashboardShell from '@/app/DashboardShell';
import BatchJobsTable from '@/components/BatchJobsTable';
import type { BatchJob } from '@/types/worker';

function computeSummary(jobs: BatchJob[]) {
  const running = jobs.filter((j) => j.status === 'RUNNING').length;
  const pending = jobs.filter((j) => ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING'].includes(j.status)).length;
  const succeeded = jobs.filter((j) => j.status === 'SUCCEEDED').length;
  const failed = jobs.filter((j) => j.status === 'FAILED').length;
  const totalGpus = jobs.reduce((sum, j) => sum + j.container.gpus, 0);
  return { total: jobs.length, running, pending, succeeded, failed, totalGpus };
}

export default function BatchJobsPage() {
  const [queueFilter, setQueueFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  return (
    <DashboardShell>
      {(ctx) => {
        const jobs = ctx.batchJobs;
        const summary = computeSummary(jobs);

        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Batch Jobs</h2>
                <p className="text-sm text-gray-500 mt-1">
                  AWS Batch job queue monitoring &middot; {summary.total} jobs tracked
                </p>
              </div>
              <span className="text-xs text-gray-400">
                Source: {ctx.dataSource === 'aws' ? 'AWS (Live)' : ctx.dataSource === 'mock' ? 'Mock Data' : '...'}
              </span>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-blue-500 p-4">
                <p className="text-sm text-gray-500">Total Jobs</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.total}</p>
              </div>
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-green-500 p-4">
                <p className="text-sm text-gray-500">Running</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.running}</p>
              </div>
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-yellow-500 p-4">
                <p className="text-sm text-gray-500">Pending</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.pending}</p>
              </div>
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-emerald-500 p-4">
                <p className="text-sm text-gray-500">Succeeded</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.succeeded}</p>
              </div>
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-red-500 p-4">
                <p className="text-sm text-gray-500">Failed</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.failed}</p>
              </div>
              <div className="bg-white rounded-lg shadow-sm border-l-4 border-purple-500 p-4">
                <p className="text-sm text-gray-500">Total GPUs</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary.totalGpus}</p>
              </div>
            </div>

            <BatchJobsTable
              jobs={jobs}
              queueFilter={queueFilter}
              statusFilter={statusFilter}
              onQueueChange={setQueueFilter}
              onStatusChange={setStatusFilter}
            />
          </div>
        );
      }}
    </DashboardShell>
  );
}
