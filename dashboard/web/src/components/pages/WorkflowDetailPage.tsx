'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Disclosure, Toast, Tabs, Stat, StatusPill, CopyButton, CodeBlock, KeyValue, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, useApi, useApiMutation, can, useMe } from '@/lib/api-client';
import { shortId } from '@/lib/format';
import { useT, useFormat } from '@/lib/i18n';
import type { Workflow, Task } from '@/server/store/types';
import { TaskTable } from '@/components/workflows/TaskTable';
import { DagView } from '@/components/workflows/DagView';
import { LogViewer } from '@/components/workflows/LogViewer';
import { TaskConnections } from '@/components/workflows/TaskConnections';
import { ArtifactViewer } from '@/components/workflows/ArtifactViewer';
import { cloneWorkflowYaml } from '@/components/workflows/clone';
import { TimeSeries, toSeries } from '@/components/charts/TimeSeries';
import { RunUsagePanel } from '@/components/usage/UsageSummary';

interface WorkflowDetailPageProps {
  id: string;
}

interface WorkflowDetail {
  workflow: Workflow;
  tasks: Task[];
}
interface WorkflowMetrics {
  gpuUtil?: Array<{ metric: Record<string, string>; values: [number, number][] }>;
  gpuMem?: Array<{ metric: Record<string, string>; values: [number, number][] }>;
  cpu?: Array<{ metric: Record<string, string>; values: [number, number][] }>;
  mem?: Array<{ metric: Record<string, string>; values: [number, number][] }>;
  errors?: Record<string, string>;
}

export function WorkflowDetailPage({ id }: WorkflowDetailPageProps) {
  const t = useT('workflowDetail');
  const tc = useT('common');
  const { ago, fmtTime, fmtDuration } = useFormat();
  const router = useRouter();
  const me = useMe();
  const locale = t.locale;
  const [selectedTask, setSelectedTask] = useState<string>();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tab, setTab] = useState<'dag' | 'tasks' | 'logs' | 'events' | 'metrics' | 'outputs' | 'spec'>('dag');
  const [toast, setToast] = useState<{ message: string; type: 'ok' | 'err' } | null>(null);

  const { data: detail, isLoading, error: detailError } = useApi<WorkflowDetail>(`/api/workflows/${id}`, {
    refetch: 4000,
  });

  const { data: events, error: eventsError } = useApi(`/api/workflows/${id}/events`, { refetch: 30_000 });
  const { data: metrics, error: metricsError } = useApi<WorkflowMetrics>(`/api/workflows/${id}/metrics`, {
    refetch: 30_000,
    enabled: me.data?.features.amp,
  });

  const cancelMut = useApiMutation(async () => {
    await api(`/api/workflows/${id}/cancel`, { method: 'POST' });
  }, [`/api/workflows/${id}`]);

  const retryMut = useApiMutation(async () => {
    await api(`/api/workflows/${id}/retry`, { method: 'POST' });
  }, [`/api/workflows/${id}`]);

  const deleteMut = useApiMutation(async () => {
    await api(`/api/workflows/${id}`, { method: 'DELETE' });
  }, ['/api/workflows']);

  const exportYaml = () => {
    window.open(`/api/workflows/${id}/export`, '_blank');
  };

  const cloneWorkflow = () => {
    if (!detail) return;
    try {
      sessionStorage.setItem('pai.cloneYaml', cloneWorkflowYaml(detail.workflow.specYaml, detail.workflow.vars, locale));
      router.push('/workflows/new');
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t('cloneFailed'), type: 'err' });
    }
  };

  const handleCancel = async () => {
    try {
      await cancelMut.mutateAsync(undefined);
      setToast({ message: t('cancelSuccess'), type: 'ok' });
      setShowCancelConfirm(false);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t('cancelFailed'), type: 'err' });
    }
  };

  const handleRetry = async () => {
    try {
      await retryMut.mutateAsync(undefined);
      setToast({ message: t('retrySuccess'), type: 'ok' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t('retryFailed'), type: 'err' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMut.mutateAsync(undefined);
      setToast({ message: t('deleteSuccess'), type: 'ok' });
      setTimeout(() => router.push('/workflows'), 1000);
      setShowDeleteConfirm(false);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t('deleteFailed'), type: 'err' });
    }
  };

  if (isLoading) return <Spinner />;
  if (!detail) return <ErrorBox error={detailError ?? { message: t('notFound') }} />;

  const { workflow, tasks } = detail;
  const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(workflow.status);
  const taskSpecs = new Map(workflow.spec.workflow.tasks.map((t) => [t.name, { resource: t.resource, image: t.image, inputs: t.inputs, outputs: t.outputs, parallelism: t.parallelism }]));
  const duration = workflow.startedAt && workflow.finishedAt ? fmtDuration(new Date(workflow.finishedAt).getTime() - new Date(workflow.startedAt).getTime()) : workflow.startedAt ? fmtDuration(Date.now() - new Date(workflow.startedAt).getTime()) : '-';

  const tabItems: { id: typeof tab; label: string }[] = [
    { id: 'dag', label: t('tabDag') },
    { id: 'tasks', label: t('tabTasks') },
    { id: 'logs', label: t('tabLogs') },
    { id: 'events', label: t('tabEvents') },
    ...(me.data?.features.amp ? [{ id: 'metrics' as const, label: t('tabMetrics') }] : []),
    { id: 'outputs', label: t('tabArtifacts') },
    { id: 'spec', label: t('tabSpec') },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{workflow.name}<StatusPill status={workflow.status} /></span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{workflow.owner} · {workflow.namespace}</span>
            <span>{t('durationCard')} {duration}{workflow.startedAt ? ` · ${fmtTime(new Date(workflow.startedAt))}` : ''}</span>
            <span className="inline-flex items-center gap-1"><code className="mono text-xs">{shortId(workflow.id)}</code><CopyButton text={workflow.id} /></span>
          </span>
        }
        actions={
          <>
            {isTerminal && can(me.data, 'researcher') && <Button onClick={handleRetry} disabled={retryMut.isPending}>{tc('retry')}</Button>}
            <Button variant="ghost" onClick={cloneWorkflow}>{t('cloneWorkflow')}</Button>
            <Button variant="ghost" onClick={exportYaml}>{t('exportYaml')}</Button>
            {!isTerminal && can(me.data, 'researcher') && <Button variant="danger" onClick={() => setShowCancelConfirm(true)} disabled={cancelMut.isPending}>{tc('stop')}</Button>}
            {isTerminal && can(me.data, 'researcher') && <Button variant="danger" onClick={() => setShowDeleteConfirm(true)} disabled={deleteMut.isPending}>{tc('delete')}</Button>}
          </>
        }
      />
      {detailError && <ErrorBox error={detailError} />}
      {tab === 'events' && eventsError && <ErrorBox error={eventsError} />}
      {tab === 'events' && (events as { kubernetesError?: string } | undefined)?.kubernetesError && <ErrorBox error={{ message: (events as { kubernetesError: string }).kubernetesError }} />}
      {tab === 'metrics' && metricsError && <ErrorBox error={metricsError} />}
      {tab === 'metrics' && Object.entries(metrics?.errors ?? {}).map(([metric, message]) => <ErrorBox key={metric} error={{ message: `${metric}: ${message}` }} />)}
      {workflow.message && workflow.status === 'FAILED' && <ErrorBox error={{ message: workflow.message }} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('progress')} value={`${workflow.succeededCount}/${workflow.taskCount}`} />
        <Stat label={t('failed')} value={String(workflow.failedCount)} tone={workflow.failedCount > 0 ? 'err' : 'ok'} />
        <Stat label={t('created')} value={ago(new Date(workflow.createdAt))} />
        <Stat label={t('template')} value={workflow.templateId || '-'} sub={workflow.message && workflow.status !== 'FAILED' ? workflow.message : undefined} />
      </div>

      <div>
        <Tabs value={tab} onChange={setTab} items={tabItems} />
        <div className="bg-gray-900/50 rounded-b p-4 min-h-96">
          {tab === 'dag' && <DagView spec={workflow.spec} tasks={tasks} selectedTask={selectedTask} onSelectTask={setSelectedTask} />}
          {tab === 'tasks' && <div className="overflow-x-auto"><TaskTable tasks={tasks} resources={workflow.spec.workflow.resources} selectedTask={selectedTask} onSelectTask={setSelectedTask} taskSpecs={taskSpecs} /></div>}
          {tab === 'logs' && <LogViewer workflowId={id} tasks={tasks} selectedTask={selectedTask} />}
          {tab === 'events' && (
            events && (events as any).controller && (events as any).controller.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium mb-2">{t('controllerEvents')}</h3>
                  <div className="space-y-2">
                    {(events as any).controller.map((e: any, i: number) => (
                      <div key={i} className="border border-gray-700 rounded p-2 text-xs">
                        <div className="flex justify-between">
                          <span className="font-medium">{e.reason}</span>
                          <span className="text-gray-400">{fmtTime(new Date(e.ts))}</span>
                        </div>
                        {e.task && <div className="text-gray-400">{tc('task')}: {e.task}</div>}
                        <div className="text-gray-300">{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {(events as any).kubernetes && (events as any).kubernetes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">{t('kubernetesEvents')}</h3>
                    <div className="space-y-2">
                      {(events as any).kubernetes.map((e: any, i: number) => (
                        <div key={i} className="border border-gray-700 rounded p-2 text-xs">
                          <div className="flex justify-between">
                            <span className="font-medium">{e.reason}</span>
                            <span className="text-gray-400">{fmtTime(new Date(e.lastTimestamp))}</span>
                          </div>
                          <div className="text-gray-300">{e.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState title={t('noEvents')} hint={t('noEventsHint')} />
            )
          )}
          {tab === 'metrics' && me.data?.features.amp && (
            metrics ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-xs font-medium mb-2">{t('gpuUtil')}</h4>
                  <TimeSeries series={toSeries((metrics as any).gpuUtil, ['pod', 'gpu'])} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">{t('gpuMem')}</h4>
                  <TimeSeries series={toSeries((metrics as any).gpuMem, ['pod', 'gpu'])} formatter={(value) => `${(value / 1024).toFixed(1)} GiB`} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">{t('cpuCores')}</h4>
                  <TimeSeries series={toSeries((metrics as any).cpu, ['pod'])} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">{t('memGib')}</h4>
                  <TimeSeries series={toSeries((metrics as any).mem, ['pod'])} formatter={(value) => `${(value / 1024 ** 3).toFixed(1)} GiB`} />
                </div>
              </div>
            ) : (
              <EmptyState title={t('noMetrics')} hint={t('noMetricsHint')} />
            )
          )}
          {tab === 'outputs' && (
            <ArtifactViewer workflowId={id} selectedTask={selectedTask} onSelectTask={setSelectedTask} running={!isTerminal} />
          )}
          {tab === 'spec' && (
            <div className="space-y-4">
              <CodeBlock code={workflow.specYaml} lang="yaml" />
              {Object.keys(workflow.vars).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-2">{t('variables')}</h3>
                  <KeyValue items={Object.entries(workflow.vars).map(([k, v]) => ({ k, v }))} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <TaskConnections workflow={workflow} tasks={tasks} selectedTask={selectedTask} onSelectTask={setSelectedTask} />

      <Disclosure title={t('usageSection')} summary={t('usageSummary')}>
        <RunUsagePanel workflowId={workflow.id} />
      </Disclosure>

      <Dialog open={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} title={t('cancelConfirmTitle')} footer={
        <>
          <Button variant="ghost" onClick={() => setShowCancelConfirm(false)}>
            {t('continueRunning')}
          </Button>
          <Button variant="danger" onClick={handleCancel} disabled={cancelMut.isPending}>
            {t('requestCancel')}
          </Button>
        </>
      }>
        {t('cancelConfirmBody')}
      </Dialog>

      <Dialog open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} title={t('deleteConfirmTitle')} footer={
        <>
          <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)}>
            {t('goBack')}
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>
            {t('confirmDelete')}
          </Button>
        </>
      }>
        {t('deleteConfirmBody')}
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
