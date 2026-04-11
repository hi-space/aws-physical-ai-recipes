import { useParams, Link, useOutletContext } from 'react-router-dom';
import type { OutletContextType } from '../components/Layout';
import WorkerInfoPanel from '../components/WorkerInfoPanel';
import RerunViewer from '../components/RerunViewer';
import TensorBoardEmbed from '../components/TensorBoardEmbed';
import TrainingMetricsChart from '../components/TrainingMetricsChart';
import GpuTimelineChart from '../components/GpuTimelineChart';
import { getMetricsByWorkerId } from '../data/mockWorkers';

export default function WorkerDetailPage() {
  const { workerId } = useParams<{ workerId: string }>();
  const { getWorkerById } = useOutletContext<OutletContextType>();

  const worker = workerId ? getWorkerById(workerId) : undefined;
  const metrics = workerId ? getMetricsByWorkerId(workerId) : undefined;

  if (!worker) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-gray-400">
        <p className="text-lg mb-2">Worker not found</p>
        <Link to="/" className="text-blue-600 hover:text-blue-800 text-sm">
          &larr; Back to Fleet Overview
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-500">
        <Link to="/" className="hover:text-blue-600">Fleet Overview</Link>
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
        <Link
          to="/"
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          &larr; Back
        </Link>
      </div>

      {/* Top row: Info panel + Training metrics */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1">
          <WorkerInfoPanel worker={worker} />
        </div>
        <div className="xl:col-span-2 space-y-6">
          <TrainingMetricsChart metrics={metrics} />
          <GpuTimelineChart worker={worker} />
        </div>
      </div>

      {/* Bottom row: Rerun + TensorBoard */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RerunViewer worker={worker} />
        <TensorBoardEmbed worker={worker} />
      </div>
    </div>
  );
}
