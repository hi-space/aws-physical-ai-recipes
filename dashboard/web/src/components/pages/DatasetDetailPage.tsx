'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Spinner,
  Textarea,
  Toast,
} from '@/components/ui';
import { ago, classNames as cx, fmtBytes } from '@/lib/format';
import { api, can, useApi, useApiMutation, useMe } from '@/lib/api-client';

interface Dataset {
  name: string;
  description?: string;
  owner: string;
  tags: string[];
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
  format?: string;
}

interface DatasetVersion {
  dataset: string;
  version: number;
  uri: string;
  fsxPath?: string;
  sizeBytes?: number;
  objectCount?: number;
  tags: string[];
  producedBy?: { workflowId: string; task: string };
  createdAt: string;
  createdBy: string;
  note?: string;
}

interface S3Entry {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  isPrefix: boolean;
}

interface S3Listing {
  bucket: string;
  prefix: string;
  entries: S3Entry[];
  nextToken?: string;
}

interface LineageData {
  produced: Array<{ version: number; workflowId: string; task: string }>;
  consumers: Array<{ workflowId: string; workflowName: string; task: string; version: 'latest' | number; status: string }>;
}

export function DatasetDetailPage({ name }: { name: string }) {
  const router = useRouter();
  const me = useMe();
  const { data, isLoading, error } = useApi<{
    dataset: Dataset;
    versions: DatasetVersion[];
    lineage: LineageData;
  }>(`/api/datasets/${name}`, { refetch: 10000 });

  const [selectedVersion, setSelectedVersion] = React.useState<number>(0);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deletePurge, setDeletePurge] = React.useState(false);
  const [fileBrowserPrefix, setFileBrowserPrefix] = React.useState('');
  const [fileBrowserToken, setFileBrowserToken] = React.useState<string | undefined>();
  const [editTagsOpen, setEditTagsOpen] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<Record<string, number>>({});

  const currentVersion = data?.versions.find((v) => v.version === selectedVersion) || data?.versions[0];

  const fileListingQuery = useApi<S3Listing>(
    currentVersion ? `/api/datasets/${name}/versions/${currentVersion.version}?prefix=${encodeURIComponent(fileBrowserPrefix)}&token=${fileBrowserToken ?? ''}` : null,
    { refetch: 0 }
  );

  const createVersionMutation = useApiMutation(
    async (input: { uri?: string; note?: string; tags?: string[] }) =>
      api<DatasetVersion>(`/api/datasets/${name}/versions`, { method: 'POST', json: input }),
    [`/api/datasets/${name}`]
  );

  const deleteMutation = useApiMutation(
    async () => api(`/api/datasets/${name}?purge=${deletePurge ? '1' : '0'}`, { method: 'DELETE' }),
    ['/api/datasets']
  );

  const refreshSizeMutation = useApiMutation(
    async () => api<DatasetVersion>(`/api/datasets/${name}/versions/${currentVersion!.version}`, { method: 'POST', json: { action: 'refresh-size' } }),
    [`/api/datasets/${name}`]
  );

  const setTagsMutation = useApiMutation(
    async (tags: string[]) =>
      api<DatasetVersion>(`/api/datasets/${name}/versions/${currentVersion!.version}`, { method: 'POST', json: { action: 'tags', tags } }),
    [`/api/datasets/${name}`]
  );

  React.useEffect(() => {
    if (data?.versions.length && selectedVersion === 0) {
      setSelectedVersion(data.versions[0].version);
    }
  }, [data?.versions, selectedVersion]);

  const handleNewVersion = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const choice = form.get('choice') as string;
    try {
      const newVer = await createVersionMutation.mutateAsync({
        uri: choice === 'existing' ? (form.get('uri') as string) : undefined,
        note: form.get('note') as string,
        tags: (form.get('tags') as string).split(',').map((t) => t.trim()).filter(Boolean),
      });
      setSelectedVersion(newVer.version);
      setNewVersionOpen(false);
      setToast({ message: 'Version created', tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create version';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      setDeleteOpen(false);
      setToast({ message: 'Dataset deleted', tone: 'ok' });
      setTimeout(() => router.push('/datasets'), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete dataset';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!currentVersion || !e.target.files) return;
    const files = Array.from(e.target.files);

    for (const file of files) {
      try {
        setUploadProgress((p) => ({ ...p, [file.name]: 0 }));

        const presignRes = await api<{ url: string; key: string }>(`/api/datasets/${name}/upload-url`, {
          method: 'POST',
          json: { version: currentVersion.version, filename: file.name, contentType: file.type },
        });

        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            setUploadProgress((p) => ({ ...p, [file.name]: Math.round((e.loaded / e.total) * 100) }));
          }
        });

        await new Promise<void>((resolve, reject) => {
          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Upload failed: ${xhr.status}`));
          });
          xhr.addEventListener('error', () => reject(new Error('Upload error')));
          xhr.open('PUT', presignRes.url);
          xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
          xhr.send(file);
        });

        setUploadProgress((p) => {
          const next = { ...p };
          delete next[file.name];
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setToast({ message: msg, tone: 'err' });
      }
    }

    fileListingQuery.refetch();
    e.target.value = '';
  };

  const handleEditTags = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const tagsStr = form.get('tags') as string;
    try {
      await setTagsMutation.mutateAsync(tagsStr.split(',').map((t) => t.trim()).filter(Boolean));
      setEditTagsOpen(false);
      setToast({ message: 'Tags updated', tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update tags';
      setToast({ message: msg, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={`Loading dataset ${name}…`} />;
  if (!data) return <EmptyState title="Dataset not found" />;

  const ds = data.dataset;

  return (
    <>
      <PageHeader title={ds.name} />

      {error && <ErrorBox error={error} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Info */}
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">Description</p>
                <p className="text-sm">{ds.description || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">Owner</p>
                <p className="text-sm">{ds.owner}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">Created</p>
                <p className="text-sm">{ago(ds.createdAt)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">Latest</p>
                <p className="text-sm mono">v{ds.latestVersion}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">Tags</p>
                {ds.tags.length === 0 ? (
                  <span className="text-xs text-gray-500">—</span>
                ) : (
                  <div className="flex gap-1 flex-wrap">
                    {ds.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Versions list */}
          <Card>
            <p className="font-semibold text-sm mb-2">Versions ({data.versions.length})</p>
            {data.versions.length === 0 ? (
              <EmptyState title="No versions" />
            ) : (
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {data.versions.map((v) => (
                  <button
                    key={v.version}
                    onClick={() => setSelectedVersion(v.version)}
                    className={cx(
                      'w-full text-left p-2 rounded text-sm border transition',
                      selectedVersion === v.version
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-gray-700 hover:border-gray-600 bg-transparent'
                    )}
                  >
                    <div className="font-mono font-semibold">v{v.version}</div>
                    <div className="text-xs text-gray-500">{ago(v.createdAt)}</div>
                    {v.producedBy && (
                      <div className="text-xs">
                        <Link href={`/workflows/${v.producedBy.workflowId}`} className="text-blue-400 hover:underline">
                          {v.producedBy.task}
                        </Link>
                      </div>
                    )}
                    {v.sizeBytes !== undefined && <div className="text-xs text-gray-500">{fmtBytes(v.sizeBytes)}</div>}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right: Version detail */}
        {currentVersion && (
          <div className="space-y-4 lg:col-span-2">
            {/* Info and actions */}
            <Card>
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">S3 URI</p>
                  <div className="flex items-center gap-2">
                    <code className="mono text-xs bg-bg-elev-2 px-2 py-1 rounded flex-1 break-all">{currentVersion.uri}</code>
                    <CopyButton text={currentVersion.uri} />
                  </div>
                </div>
                {currentVersion.fsxPath && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-1">FSx Path</p>
                    <div className="flex items-center gap-2">
                      <code className="mono text-xs bg-bg-elev-2 px-2 py-1 rounded flex-1 break-all">{currentVersion.fsxPath}</code>
                      <CopyButton text={currentVersion.fsxPath} />
                    </div>
                  </div>
                )}
                {currentVersion.note && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-1">Note</p>
                    <p className="text-sm">{currentVersion.note}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">Created</p>
                  <p className="text-sm">{ago(currentVersion.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">Created By</p>
                  <p className="text-sm">{currentVersion.createdBy}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">Size</p>
                  <p className="text-sm">{fmtBytes(currentVersion.sizeBytes)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">Objects</p>
                  <p className="text-sm">{currentVersion.objectCount !== undefined ? currentVersion.objectCount : '—'}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-2">Usage</p>
                  <CodeBlock
                    code={`inputs:
  - dataset:
      name: ${ds.name}
      version: ${currentVersion.version}
      path: /data`}
                    lang="yaml"
                  />
                </div>

                {can(me.data, 'researcher') && (
                  <div className="flex gap-2 pt-2">
                    <Button size="sm" onClick={() => refreshSizeMutation.mutate()} loading={refreshSizeMutation.isPending}>
                      Refresh size
                    </Button>
                    <Button size="sm" onClick={() => setEditTagsOpen(true)} variant="ghost">
                      Edit tags
                    </Button>
                  </div>
                )}
              </div>
            </Card>

            {/* Edit tags dialog */}
            {editTagsOpen && (
              <Dialog
                open={editTagsOpen}
                onClose={() => setEditTagsOpen(false)}
                title="Edit Tags"
              >
                <form onSubmit={handleEditTags} className="space-y-4">
                  <Field label="Tags" help="Comma-separated">
                    <Input
                      name="tags"
                      defaultValue={currentVersion.tags.join(', ')}
                      placeholder="tag1, tag2"
                    />
                  </Field>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" onClick={() => setEditTagsOpen(false)} variant="ghost">
                      Cancel
                    </Button>
                    <Button type="submit" loading={setTagsMutation.isPending}>
                      Save
                    </Button>
                  </div>
                </form>
              </Dialog>
            )}

            {/* New version dialog */}
            {newVersionOpen && (
              <Dialog
                open={newVersionOpen}
                onClose={() => setNewVersionOpen(false)}
                title="Create New Version"
              >
                <form onSubmit={handleNewVersion} className="space-y-4">
                  <Field label="Source">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2">
                        <input type="radio" name="choice" value="empty" defaultChecked /> Empty upload prefix
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name="choice" value="existing" /> Existing S3 URI
                      </label>
                    </div>
                  </Field>
                  <Field label="URI" help="Only for existing S3 URI">
                    <Input name="uri" placeholder="s3://bucket/prefix/" />
                  </Field>
                  <Field label="Note">
                    <Textarea name="note" placeholder="Changes in this version…" maxLength={500} rows={3} />
                  </Field>
                  <Field label="Tags" help="Comma-separated">
                    <Input name="tags" placeholder="training, processed" />
                  </Field>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" onClick={() => setNewVersionOpen(false)} variant="ghost">
                      Cancel
                    </Button>
                    <Button type="submit" loading={createVersionMutation.isPending}>
                      Create
                    </Button>
                  </div>
                </form>
              </Dialog>
            )}

            {/* Delete dialog */}
            {deleteOpen && (
              <Dialog
                open={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title="Delete Dataset"
              >
                <div className="space-y-4">
                  <p>Are you sure? This will delete all metadata and versions.</p>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={deletePurge} onChange={(e) => setDeletePurge(e.target.checked)} />
                    <span className="text-sm">Also delete S3 objects under datasets/{ds.name}/ (purge)</span>
                  </label>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" onClick={() => setDeleteOpen(false)} variant="ghost">
                      Cancel
                    </Button>
                    <Button onClick={handleDelete} loading={deleteMutation.isPending}>
                      Delete
                    </Button>
                  </div>
                </div>
              </Dialog>
            )}

            {/* File browser */}
            <Card>
              <p className="font-semibold text-sm mb-3">Files</p>
              {fileListingQuery.isLoading && !fileListingQuery.data && <Spinner label="Loading files…" />}
              {fileListingQuery.error && <ErrorBox error={fileListingQuery.error} />}
              {fileListingQuery.data && (
                <div className="space-y-4">
                  {/* Breadcrumb */}
                  <div className="flex items-center gap-1 text-sm flex-wrap">
                    <button
                      onClick={() => {
                        setFileBrowserPrefix('');
                        setFileBrowserToken(undefined);
                      }}
                      className="text-blue-400 hover:underline"
                    >
                      {fileListingQuery.data.bucket}
                    </button>
                    {fileListingQuery.data.prefix && (
                      <>
                        <span className="text-gray-500">/</span>
                        {fileListingQuery.data.prefix.split('/').filter(Boolean).map((part, i, arr) => {
                          const prefix = arr.slice(0, i + 1).join('/') + '/';
                          return (
                            <React.Fragment key={i}>
                              <button
                                onClick={() => {
                                  setFileBrowserPrefix(prefix);
                                  setFileBrowserToken(undefined);
                                }}
                                className="text-blue-400 hover:underline"
                              >
                                {part}
                              </button>
                              {i < arr.length - 1 && <span className="text-gray-500">/</span>}
                            </React.Fragment>
                          );
                        })}
                      </>
                    )}
                  </div>

                  {/* Upload area */}
                  {can(me.data, 'researcher') && (
                    <label className="block p-4 border-2 border-dashed border-gray-600 rounded text-center cursor-pointer hover:border-gray-500">
                      <input
                        type="file"
                        multiple
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                      <div className="text-sm text-gray-400">Drop files here or click to upload</div>
                    </label>
                  )}

                  {/* Upload progress */}
                  {Object.entries(uploadProgress).length > 0 && (
                    <div className="space-y-2">
                      {Object.entries(uploadProgress).map(([name, pct]) => (
                        <div key={name} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span>{name}</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-1 bg-gray-700 rounded overflow-hidden">
                            <div style={{ width: `${pct}%` }} className="h-full bg-blue-500 transition-all" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* File table */}
                  {fileListingQuery.data.entries.length === 0 ? (
                    <EmptyState title="No files" />
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-border">
                        <tr>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Name</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Size</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Modified</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fileListingQuery.data.entries.map((e) => (
                          <tr key={e.key} className="border-b border-border hover:bg-bg-elev-1 transition">
                            <td className="py-2 px-3">
                              {e.isPrefix ? (
                                <button
                                  onClick={() => {
                                    setFileBrowserPrefix(e.key);
                                    setFileBrowserToken(undefined);
                                  }}
                                  className="text-blue-400 hover:underline font-mono text-sm"
                                >
                                  {e.name}/
                                </button>
                              ) : (
                                <span className="font-mono text-sm">
                                  {e.name}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs">{fmtBytes(e.size)}</td>
                            <td className="py-2 px-3 text-xs text-gray-500">{ago(e.lastModified)}</td>
                            <td className="py-2 px-3">
                              {!e.isPrefix && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    try {
                                      const res = await api<{ url: string }>('/api/s3/presign', {
                                        method: 'POST',
                                        json: { bucket: fileListingQuery.data!.bucket, key: e.key, op: 'get' },
                                      });
                                      window.open(res.url);
                                    } catch (err) {
                                      const msg = err instanceof Error ? err.message : 'Download failed';
                                      setToast({ message: msg, tone: 'err' });
                                    }
                                  }}
                                >
                                  Download
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Load more */}
                  {fileListingQuery.data.nextToken && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setFileBrowserToken(fileListingQuery.data!.nextToken)}
                      className="w-full"
                    >
                      Load more
                    </Button>
                  )}
                </div>
              )}
            </Card>

            {/* Lineage */}
            {(data.lineage.produced.length > 0 || data.lineage.consumers.length > 0) && (
              <Card>
                <p className="font-semibold text-sm mb-3">Lineage</p>
                {data.lineage.produced.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-gray-400 mb-2">Produced By</p>
                    <div className="space-y-1">
                      {data.lineage.produced.map((p) => (
                        <Link
                          key={`${p.workflowId}-${p.version}`}
                          href={`/workflows/${p.workflowId}`}
                          className="block text-sm text-blue-400 hover:underline"
                        >
                          v{p.version} — {p.task}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {data.lineage.consumers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-2">Consumers</p>
                    <table className="w-full text-sm">
                      <thead className="border-b border-border">
                        <tr>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Workflow</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Task</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Version</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lineage.consumers.map((c) => (
                          <tr key={`${c.workflowId}-${c.task}`} className="border-b border-border hover:bg-bg-elev-1 transition">
                            <td className="py-2 px-3">
                              <Link
                                href={`/workflows/${c.workflowId}`}
                                className="text-blue-400 hover:underline text-sm"
                              >
                                {c.workflowName}
                              </Link>
                            </td>
                            <td className="py-2 px-3 text-sm">{c.task}</td>
                            <td className="py-2 px-3 mono text-sm">{c.version === 'latest' ? 'latest' : `v${c.version}`}</td>
                            <td className="py-2 px-3">
                              <Badge>{c.status}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}

            {/* Action buttons */}
            {can(me.data, 'researcher') && (
              <div className="flex gap-2">
                <Button onClick={() => setNewVersionOpen(true)}>New version</Button>
                <Button onClick={() => setDeleteOpen(true)}>Delete</Button>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
