'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Worker, FleetSummary, Experiment, TrainingMetrics, BatchJob } from '@/types/worker';
import { simulateMetricsUpdate } from '@/data/mockWorkers';

export function useWorkers() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [trainingMetrics, setTrainingMetrics] = useState<TrainingMetrics[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string>('all');
  const [dataSource, setDataSource] = useState<string>('loading');
  const [error, setError] = useState<string | null>(null);

  // Fetch workers from API
  const fetchWorkers = useCallback(async () => {
    try {
      const res = await fetch('/api/workers');
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setWorkers(data.workers);
      setDataSource(data.source);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Fetch batch jobs from API
  const fetchBatchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/batch-jobs');
      const data = await res.json();
      if (!data.error) setBatchJobs(data.jobs);
    } catch {
      // Batch jobs are supplementary, don't fail on error
    }
  }, []);

  // Fetch experiments from API
  const fetchExperiments = useCallback(async () => {
    try {
      const res = await fetch('/api/experiments');
      const data = await res.json();
      if (!data.error) {
        setExperiments(data.experiments);
        setTrainingMetrics(data.trainingMetrics);
      }
    } catch {
      // Experiments are supplementary
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchWorkers();
    fetchBatchJobs();
    fetchExperiments();
  }, [fetchWorkers, fetchBatchJobs, fetchExperiments]);

  // Polling: refresh from API every 30s, simulate metrics jitter every 3s
  useEffect(() => {
    const jitterInterval = setInterval(() => {
      setWorkers((prev) => (prev.length > 0 ? simulateMetricsUpdate(prev) : prev));
    }, 3000);

    const pollInterval = setInterval(() => {
      fetchWorkers();
      fetchBatchJobs();
    }, 30000);

    return () => {
      clearInterval(jitterInterval);
      clearInterval(pollInterval);
    };
  }, [fetchWorkers, fetchBatchJobs]);

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
    batchJobs,
    dataSource,
    error,
  };
}
