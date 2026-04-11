'use client';

import { use } from 'react';
import Link from 'next/link';
import DashboardShell from '@/app/DashboardShell';
import WorkerInfoPanel from '@/components/WorkerInfoPanel';
import RerunViewer from '@/components/RerunViewer';
import TensorBoardEmbed from '@/components/TensorBoardEmbed';
import TrainingMetricsChart from '@/components/TrainingMetricsChart';
import GpuTimelineChart from '@/components/GpuTimelineChart';

export default function WorkerDetailPage({ params }: { params: Promise<{ workerId: string }> }) {
  const { workerId } = use(params);

  return (
    <DashboardShell>
      {(ctx) => {
        const worker = ctx.getWorkerById(workerId);
        const metrics = ctx.trainingMetrics.find((m) => m.workerId === workerId);

        if (!worker) {
          return (
            <div className="flex flex-col items-center justify-center h-96 text-gray-400">
              <p className="text-lg mb-2">Worker not found</p>
              <Link href="/" className="text-blue-600 hover:text-blue-800 text-sm">&larr; Back to Fleet Overview</Link>
            </div>
          );
        }

        return (
          <div className="space-y-6">
            <nav className="flex items-center gap-2 text-sm text-gray-500">
              <Link href="/" className="hover:text-blue-600">Fleet Overview</Link>
              <span>/</span>
              <span className="text-gray-800 font-medium">{worker.id}</span>
            </nav>

            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{worker.taskName}</h2>
                <p className="text-sm text-gray-500 mt-1">
                  {worker.instanceId} &middot; {worker.instanceType} &middot; {worker.region}
                </p>
              </div>
              <Link href="/" className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                &larr; Back
              </Link>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <div className="xl:col-span-1">
                <WorkerInfoPanel worker={worker} />
              </div>
              <div className="xl:col-span-2 space-y-6">
                <TrainingMetricsChart metrics={metrics} />
                <GpuTimelineChart worker={worker} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <RerunViewer worker={worker} />
              <TensorBoardEmbed worker={worker} />
            </div>
          </div>
        );
      }}
    </DashboardShell>
  );
}
