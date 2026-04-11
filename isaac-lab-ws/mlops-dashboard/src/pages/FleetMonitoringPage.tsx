import { useOutletContext } from 'react-router-dom';
import type { OutletContextType } from '../components/Layout';
import FleetSummaryCards from '../components/FleetSummaryCards';
import RegionFilter from '../components/RegionFilter';
import WorkerTable from '../components/WorkerTable';
import DdpTopologyView from '../components/DdpTopologyView';

export default function FleetMonitoringPage() {
  const { filteredWorkers, workers, regions, selectedRegion, setSelectedRegion, summary, experiments } =
    useOutletContext<OutletContextType>();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Fleet Overview</h2>
          <p className="text-sm text-gray-500 mt-1">
            Monitoring {summary.total} worker instances across {regions.length} regions
          </p>
        </div>
        <div className="text-xs text-gray-400">
          Auto-refresh: 3s
        </div>
      </div>

      <FleetSummaryCards summary={summary} />

      <DdpTopologyView workers={workers} experiments={experiments} />

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-800">Worker Instances</h3>
        <RegionFilter regions={regions} selected={selectedRegion} onChange={setSelectedRegion} />
      </div>

      <WorkerTable workers={filteredWorkers} />
    </div>
  );
}
