'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Spinner,
  StatusPill,
  Textarea,
  Toast,
} from '@/components/ui';
import { fmtNum } from '@/lib/format';
import { api, can, useApi, useApiMutation, useMe } from '@/lib/api-client';
import { S3Browser } from '@/components/storage/S3Browser';

interface Bucket {
  name: string;
  label: string;
}

interface FileSystem {
  id: string;
  label: string;
  lifecycle: string;
  storageCapacityGiB: number;
  dnsName?: string;
  mountName?: string;
  associations?: Array<{
    fileSystemPath: string;
    dataRepositoryPath: string;
    lifecycle: string;
    autoImport?: string[];
    autoExport?: string[];
  }>;
}

interface DataRepositoryTask {
  TaskId: string;
  Lifecycle: string;
  Type: string;
  Paths?: string[];
  CreationTime?: string;
  StartTime?: string;
  EndTime?: string;
  Status?: {
    TotalCount?: number;
    SucceededCount?: number;
    FailedCount?: number;
  };
}

export function StoragePage() {
  const me = useMe();
  const { data: bucketsData, isLoading: bucketsLoading, error: bucketsError } = useApi<{ buckets: Bucket[] }>('/api/s3', { refetch: 0 });
  const { data: fsxData, isLoading: fsxLoading, error: fsxError } = useApi<FileSystem[]>('/api/fsx', { refetch: 10000 });
  const [selectedBucket, setSelectedBucket] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [selectedFileSystemId, setSelectedFileSystemId] = React.useState<string | null>(null);

  const fsx = fsxData ? fsxData[0] : null;
  const tasksQuery = useApi<DataRepositoryTask[]>(
    selectedFileSystemId ? `/api/fsx/tasks?fileSystemId=${selectedFileSystemId}` : null,
    { refetch: 5000 }
  );

  React.useEffect(() => {
    if (bucketsData?.buckets.length && !selectedBucket) {
      setSelectedBucket(bucketsData.buckets[0].name);
    }
  }, [bucketsData, selectedBucket]);

  React.useEffect(() => {
    if (fsx?.id && !selectedFileSystemId) {
      setSelectedFileSystemId(fsx.id);
    }
  }, [fsx, selectedFileSystemId]);

  const createTaskMutation = useApiMutation(
    async (input: { fileSystemId: string; type: 'EXPORT_TO_REPOSITORY' | 'IMPORT_METADATA_FROM_REPOSITORY'; paths: string[] }) =>
      api('/api/fsx/tasks', { method: 'POST', json: input }),
    selectedFileSystemId ? [`/api/fsx/tasks?fileSystemId=${selectedFileSystemId}`] : []
  );

  const handleCreateTask = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedFileSystemId) return;
    const form = new FormData(e.currentTarget);
    const pathsStr = form.get('paths') as string;
    try {
      await createTaskMutation.mutateAsync({
        fileSystemId: selectedFileSystemId,
        type: form.get('type') as any,
        paths: pathsStr.split('\n').map((p) => p.trim()).filter(Boolean),
      });
      setTaskOpen(false);
      setToast({ message: 'Task created', tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create task';
      setToast({ message: msg, tone: 'err' });
    }
  };

  if ((bucketsLoading && !bucketsData) || (fsxLoading && !fsxData)) {
    return <Spinner label="Loading storage…" />;
  }

  return (
    <>
      <PageHeader title="Storage" />
      <div className="space-y-4">
        {(bucketsError || fsxError) && <ErrorBox error={bucketsError || fsxError} />}

        {/* S3 Tabs */}
        {bucketsData?.buckets && bucketsData.buckets.length > 0 ? (
          <div className="space-y-4">
            {/* Tab buttons */}
            <div className="flex items-center gap-1 border-b border-border">
              {bucketsData.buckets.map((b) => (
                <button
                  key={b.name}
                  onClick={() => setSelectedBucket(b.name)}
                  className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                    selectedBucket === b.name
                      ? 'border-accent text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {selectedBucket && (
              <Card>
                <S3Browser
                  key={selectedBucket}
                  bucket={selectedBucket}
                  initialPrefix=""
                  allowUpload={can(me.data, 'researcher')}
                  allowDelete={can(me.data, 'researcher')}
                />
              </Card>
            )}
          </div>
        ) : (
          <EmptyState title="No buckets" />
        )}

        {/* FSx for Lustre */}
        {fsx ? (
          <Card>
            <div className="space-y-4">
              <p className="font-semibold text-sm">FSx for Lustre</p>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Lifecycle</p>
                  <StatusPill status={fsx.lifecycle} />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Capacity</p>
                  <p className="text-sm font-semibold">{fmtNum(fsx.storageCapacityGiB)} GiB</p>
                </div>
                {fsx.dnsName && (
                  <div>
                    <p className="text-xs text-gray-400 mb-1">DNS</p>
                    <p className="text-xs font-mono break-all">{fsx.dnsName}</p>
                  </div>
                )}
                {fsx.mountName && (
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Mount</p>
                    <p className="text-xs font-mono">{fsx.mountName}</p>
                  </div>
                )}
              </div>

              {/* Associations */}
              {fsx.associations && fsx.associations.length > 0 && (
                <div className="space-y-3">
                  <p className="font-semibold text-sm">Data Repository Associations</p>
                  <table className="w-full text-sm">
                    <thead className="border-b border-border">
                      <tr>
                        <th className="py-2 px-3 text-left text-xs font-semibold">FSx Path</th>
                        <th className="py-2 px-3 text-left text-xs font-semibold">S3 Path</th>
                        <th className="py-2 px-3 text-left text-xs font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fsx.associations.map((a) => (
                        <tr key={`${a.fileSystemPath}-${a.dataRepositoryPath}`} className="border-b border-border hover:bg-bg-elev-1 transition">
                          <td className="py-2 px-3 mono text-xs">{a.fileSystemPath}</td>
                          <td className="py-2 px-3 mono text-xs">{a.dataRepositoryPath}</td>
                          <td className="py-2 px-3">
                            <StatusPill status={a.lifecycle} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Tasks */}
              <div className="space-y-3 pt-3 border-t border-border">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-sm">Data Repository Tasks</p>
                  {can(me.data, 'researcher') && (
                    <Button size="sm" onClick={() => setTaskOpen(true)}>
                      Create task
                    </Button>
                  )}
                </div>

                {taskOpen && (
                  <Dialog
                    open={taskOpen}
                    onClose={() => setTaskOpen(false)}
                    title="Create Data Repository Task"
                  >
                    <form onSubmit={handleCreateTask} className="space-y-4">
                      <div>
                        <label className="block text-sm font-semibold mb-2">Type</label>
                        <div className="space-y-2">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="type"
                              value="IMPORT_METADATA_FROM_REPOSITORY"
                              defaultChecked
                            />
                            <span className="text-sm">Import metadata from S3</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="radio" name="type" value="EXPORT_TO_REPOSITORY" />
                            <span className="text-sm">Export to S3</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-semibold mb-2">Paths (one per line)</label>
                        <Textarea
                          name="paths"
                          placeholder="/fsx/checkpoints"
                          defaultValue="/fsx/checkpoints"
                          rows={5}
                        />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button type="button" onClick={() => setTaskOpen(false)} variant="ghost">
                          Cancel
                        </Button>
                        <Button type="submit" loading={createTaskMutation.isPending}>
                          Create
                        </Button>
                      </div>
                    </form>
                  </Dialog>
                )}

                {tasksQuery.isLoading && !tasksQuery.data ? (
                  <Spinner label="Loading tasks…" />
                ) : !tasksQuery.data || tasksQuery.data.length === 0 ? (
                  <EmptyState title="No tasks" />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-border">
                      <tr>
                        <th className="py-2 px-3 text-left text-xs font-semibold">Task ID</th>
                        <th className="py-2 px-3 text-left text-xs font-semibold">Type</th>
                        <th className="py-2 px-3 text-left text-xs font-semibold">Status</th>
                        <th className="py-2 px-3 text-left text-xs font-semibold">Progress</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasksQuery.data.map((t) => (
                        <tr key={t.TaskId} className="border-b border-border hover:bg-bg-elev-1 transition">
                          <td className="py-2 px-3 mono text-xs">{t.TaskId}</td>
                          <td className="py-2 px-3 text-xs">{t.Type.replace(/_/g, ' ')}</td>
                          <td className="py-2 px-3">
                            <StatusPill status={t.Lifecycle} />
                          </td>
                          <td className="py-2 px-3">
                            <div className="space-y-1">
                              {t.Status && (
                                <>
                                  <div className="text-xs text-gray-500">
                                    {t.Status.SucceededCount || 0}/{t.Status.TotalCount || 0}
                                    {t.Status.FailedCount ? ` • ${t.Status.FailedCount} failed` : ''}
                                  </div>
                                  {(t.Status.TotalCount ?? 0) > 0 && (
                                    <div className="h-1 bg-gray-700 rounded overflow-hidden">
                                      <div
                                        style={{
                                          width: `${Math.round(((t.Status.SucceededCount ?? 0) / (t.Status.TotalCount ?? 1)) * 100)}%`,
                                        }}
                                        className="h-full bg-blue-500"
                                      />
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </Card>
        ) : (
          <EmptyState title="No FSx deployment" />
        )}
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
