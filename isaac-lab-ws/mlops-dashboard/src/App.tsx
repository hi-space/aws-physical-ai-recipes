import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import FleetMonitoringPage from './pages/FleetMonitoringPage';
import WorkerDetailPage from './pages/WorkerDetailPage';
import ExperimentsPage from './pages/ExperimentsPage';
import { useWorkers } from './hooks/useWorkers';

export default function App() {
  const workerData = useWorkers();

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout context={workerData} />}>
          <Route index element={<FleetMonitoringPage />} />
          <Route path="worker/:workerId" element={<WorkerDetailPage />} />
          <Route path="experiments" element={<ExperimentsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
