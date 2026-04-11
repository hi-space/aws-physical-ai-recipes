import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import type { Worker, FleetSummary, Experiment, TrainingMetrics } from '../types/worker';

export interface OutletContextType {
  workers: Worker[];
  filteredWorkers: Worker[];
  regions: string[];
  selectedRegion: string;
  setSelectedRegion: (r: string) => void;
  summary: FleetSummary;
  getWorkerById: (id: string) => Worker | undefined;
  experiments: Experiment[];
  trainingMetrics: TrainingMetrics[];
}

interface LayoutProps {
  context: OutletContextType;
}

export default function Layout({ context }: LayoutProps) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-60 flex-1 p-6 bg-gray-50 min-h-screen">
        <Outlet context={context} />
      </main>
    </div>
  );
}
