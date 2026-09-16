'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Toast, Tabs, Card, Stat, StatusPill, CopyButton, CodeBlock, KeyValue, EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useApi, useApiMutation, can, useMe } from '@/lib/api-client';
import { shortId, ago, fmtTime, fmtDuration } from '@/lib/format';
import type { Workflow, Task } from '@/server/store/types';
import { TaskTable } from '@/components/workflows/TaskTable';
import { DagView } from '@/components/workflows/DagView';
import { LogViewer } from '@/components/workflows/LogViewer';
import { TimeSeries, toSeries } from '@/components/charts/TimeSeries';

interface WorkflowDetailPageProps {
  id: string;
}

interface WorkflowDetail {
  workflow: Workflow;
  tasks: Task[];
}

export function WorkflowDetailPage({ id }: WorkflowDetailPageProps) {
  const router = useRouter();
  const me = useMe();
  const [selectedTask, setSelectedTask] = useState<string>();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tab, setTab] = useState<'dag' | 'tasks' | 'logs' | 'events' | 'metrics' | 'outputs' | 'spec'>('dag');
  const [toast, setToast] = useState<{ message: string; type: 'ok' | 'err' } | null>(null);

  const { data: detail, isLoading } = useApi<WorkflowDetail>(`/api/workflows/${id}`, {
    refetch: 4000,
  });

  const { data: events } = useApi(`/api/workflows/${id}/events`, { refetch: 30_000 });
  const { data: metrics } = useApi(`/api/workflows/${id}/metrics`, {
    refetch: 30_000,
    enabled: me.data?.features.amp,
  });

  const cancelMut = useApiMutation(async () => {
    await fetch(`/api/workflows/${id}/cancel`, { method: 'POST' });
  }, [`/api/workflows/${id}`]);

  const retryMut = useApiMutation(async () => {
    await fetch(`/api/workflows/${id}/retry`, { method: 'POST' });
  }, [`/api/workflows/${id}`]);

  const deleteMut = useApiMutation(async () => {
    await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
  }, ['/api/workflows']);

  const exportYaml = () => {
    window.open(`/api/workflows/${id}/export`, '_blank');
  };

  const cloneWorkflow = () => {
    if (detail?.workflow.templateId) {
      router.push(`/workflows/new?template=${detail.workflow.templateId}`);
    } else {
      sessionStorage.setItem('pai.cloneYaml', detail?.workflow.specYaml || '');
      router.push('/workflows/new');
    }
  };

  const handleCancel = async () => {
    try {
      await cancelMut.mutateAsync(undefined);
      setToast({ message: 'Workflow cancelled', type: 'ok' });
      setShowCancelConfirm(false);
    } catch {
      setToast({ message: 'Failed to cancel workflow', type: 'err' });
    }
  };

  const handleRetry = async () => {
    try {
      await retryMut.mutateAsync(undefined);
      setToast({ message: 'Workflow retried', type: 'ok' });
    } catch {
      setToast({ message: 'Failed to retry workflow', type: 'err' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMut.mutateAsync(undefined);
      setToast({ message: 'Workflow deleted', type: 'ok' });
      setTimeout(() => router.push('/workflows'), 1000);
      setShowDeleteConfirm(false);
    } catch {
      setToast({ message: 'Failed to delete workflow', type: 'err' });
    }
  };

  if (isLoading) return <Spinner />;
  if (!detail) return <ErrorBox error={{ message: 'Workflow not found' }} />;

  const { workflow, tasks } = detail;
  const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(workflow.status);
  const taskSpecs = new Map(workflow.spec.workflow.tasks.map((t) => [t.name, { resource: t.resource, image: t.image, inputs: t.inputs, outputs: t.outputs, parallelism: t.parallelism }]));
  const duration = workflow.startedAt && workflow.finishedAt ? fmtDuration(new Date(workflow.finishedAt).getTime() - new Date(workflow.startedAt).getTime()) : workflow.startedAt ? fmtDuration(Date.now() - new Date(workflow.startedAt).getTime()) : '-';

  const tabItems: { id: typeof tab; label: string }[] = [
    { id: 'dag', label: 'DAG' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'logs', label: 'Logs' },
    { id: 'events', label: 'Events' },
    ...(me.data?.features.amp ? [{ id: 'metrics' as const, label: 'Metrics' }] : []),
    { id: 'outputs', label: 'Outputs' },
    { id: 'spec', label: 'Spec' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={workflow.name} />

      <div className="grid grid-cols-3 gap-4">
        <Card title="Status">
          <StatusPill status={workflow.status} />
          <div className="flex gap-2 items-center mt-2">
            <code className="mono text-xs bg-gray-800 px-2 py-1 rounded flex-1">{shortId(workflow.id)}</code>
            <CopyButton text={workflow.id} />
          </div>
        </Card>
        <Card title="Owner / Namespace">
          <div className="space-y-1 text-xs">
            <div>{workflow.owner}</div>
            <div className="text-gray-400">{workflow.namespace}</div>
          </div>
        </Card>
        <Card title="Duration">
          <div className="space-y-1 text-xs">
            <div className="font-medium">{duration}</div>
            <div className="text-gray-400">
              {workflow.startedAt ? `${fmtTime(new Date(workflow.startedAt))}` : '-'}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-5 gap-2">
        <Stat label="Progress" value={`${workflow.succeededCount}/${workflow.taskCount}`} />
        <Stat label="Failed" value={String(workflow.failedCount)} tone={workflow.failedCount > 0 ? 'err' : 'ok'} />
        <Stat label="Created" value={ago(new Date(workflow.createdAt))} />
        <Stat label="Template" value={workflow.templateId || '-'} />
        <Stat label="Message" value={workflow.message || '-'} />
      </div>

      {workflow.message && workflow.status === 'FAILED' && <ErrorBox error={{ message: workflow.message }} />}

      <div className="flex gap-2">
        {!isTerminal && can(me.data, 'researcher') && <Button variant="danger" size="sm" onClick={() => setShowCancelConfirm(true)} disabled={cancelMut.isPending}>
          Cancel
        </Button>}
        {isTerminal && can(me.data, 'researcher') && <Button size="sm" onClick={handleRetry} disabled={retryMut.isPending}>
          Retry
        </Button>}
        <Button size="sm" variant="ghost" onClick={cloneWorkflow}>
          Clone
        </Button>
        <Button size="sm" variant="ghost" onClick={exportYaml}>
          Export YAML
        </Button>
        {isTerminal && can(me.data, 'researcher') && <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(true)} disabled={deleteMut.isPending}>
          Delete
        </Button>}
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
                  <h3 className="text-sm font-medium mb-2">Controller Events</h3>
                  <div className="space-y-2">
                    {(events as any).controller.map((e: any, i: number) => (
                      <div key={i} className="border border-gray-700 rounded p-2 text-xs">
                        <div className="flex justify-between">
                          <span className="font-medium">{e.reason}</span>
                          <span className="text-gray-400">{fmtTime(new Date(e.ts))}</span>
                        </div>
                        {e.task && <div className="text-gray-400">Task: {e.task}</div>}
                        <div className="text-gray-300">{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {(events as any).kubernetes && (events as any).kubernetes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Kubernetes Events</h3>
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
              <EmptyState title="No events" hint="Events will appear here as the workflow executes." />
            )
          )}
          {tab === 'metrics' && me.data?.features.amp && (
            metrics ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-xs font-medium mb-2">GPU Utilization (%)</h4>
                  <TimeSeries series={toSeries((metrics as any).gpuUtil, ['pod', 'gpu'])} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">GPU Memory (GiB)</h4>
                  <TimeSeries series={toSeries((metrics as any).gpuMem, ['pod', 'gpu'])} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">CPU (cores)</h4>
                  <TimeSeries series={toSeries((metrics as any).cpu, ['pod'])} />
                </div>
                <div>
                  <h4 className="text-xs font-medium mb-2">Memory (GiB)</h4>
                  <TimeSeries series={toSeries((metrics as any).mem, ['pod'])} />
                </div>
              </div>
            ) : (
              <EmptyState title="No metrics" hint="Metrics not available for this workflow." />
            )
          )}
          {tab === 'outputs' && (
            tasks.some((t) => t.publishedVersions && t.publishedVersions.length > 0) ? (
              <div className="space-y-4">
                {tasks
                  .filter((t) => t.publishedVersions && t.publishedVersions.length > 0)
                  .map((t) => (
                    <div key={t.name}>
                      <h3 className="text-sm font-medium mb-2">{t.name}</h3>
                      <div className="space-y-1">
                        {t.publishedVersions?.map((v) => (
                          <div key={v.dataset} className="text-sm">
                            <a href={`/datasets/${v.dataset}`} className="text-blue-400 hover:text-blue-300">
                              {v.dataset}
                            </a>
                            <span className="text-gray-400"> v{v.version}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <EmptyState title="No outputs" hint="This workflow has not published any dataset versions." />
            )
          )}
          {tab === 'spec' && (
            <div className="space-y-4">
              <CodeBlock code={workflow.specYaml} lang="yaml" />
              {Object.keys(workflow.vars).length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-2">Variables</h3>
                  <KeyValue items={Object.entries(workflow.vars).map(([k, v]) => ({ k, v }))} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog open={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} title="Cancel workflow?" footer={
        <>
          <Button variant="ghost" onClick={() => setShowCancelConfirm(false)}>
            No, keep it
          </Button>
          <Button variant="danger" onClick={handleCancel} disabled={cancelMut.isPending}>
            Yes, cancel
          </Button>
        </>
      }>
        This will stop the workflow and cancel pending tasks.
      </Dialog>

      <Dialog open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} title="Delete workflow?" footer={
        <>
          <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>
            Delete
          </Button>
        </>
      }>
        This action cannot be undone. The workflow and its records will be permanently deleted.
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
