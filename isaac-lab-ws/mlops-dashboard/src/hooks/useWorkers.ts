import { useState, useEffect, useMemo, useCallback } from 'react';
import { Worker, FleetSummary } from '../types/worker';
import { mockWorkers, simulateMetricsUpdate, mockExperiments, mockTrainingMetrics } from '../data/mockWorkers';
import type { Experiment, TrainingMetrics } from '../types/worker';

export function useWorkers() {
  const [workers, setWorkers] = useState<Worker[]>(mockWorkers);
  const [selectedRegion, setSelectedRegion] = useState<string>('all');

  useEffect(() => {
    const interval = setInterval(() => {
      setWorkers((prev) => simulateMetricsUpdate(prev));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const regions = useMemo(() => {
    const set = new Set(workers.map((w) => w.region));
    return Array.from(set).sort();
  }, [workers]);

  const filteredWorkers = useMemo(() => {
    if (selectedRegion === 'all') return workers;
    return workers.filter((w) => w.region === selectedRegion);
  }, [workers, selectedRegion]);

  const summary: FleetSummary = useMemo(() => {
    const running = workers.filter((w) => w.status === 'RUNNING');
    return {
      total: workers.length,
      running: running.length,
      pending: workers.filter((w) => w.status === 'PENDING').length,
      stopped: workers.filter((w) => w.status === 'STOPPED').length,
      failed: workers.filter((w) => w.status === 'FAILED').length,
      avgGpuUtilization: running.length
        ? Math.round(running.reduce((sum, w) => sum + w.gpuUtilization, 0) / running.length)
        : 0,
      totalGpus: workers.reduce((sum, w) => sum + w.gpuCount, 0),
      bestReward: Math.max(...workers.map((w) => w.currentReward), 0),
    };
  }, [workers]);

  const getWorkerById = useCallback(
    (id: string) => workers.find((w) => w.id === id),
    [workers],
  );

  const experiments: Experiment[] = mockExperiments;
  const trainingMetrics: TrainingMetrics[] = mockTrainingMetrics;

  return {
    workers,
    filteredWorkers,
    regions,
    selectedRegion,
    setSelectedRegion,
    summary,
    getWorkerById,
    experiments,
    trainingMetrics,
  };
}
