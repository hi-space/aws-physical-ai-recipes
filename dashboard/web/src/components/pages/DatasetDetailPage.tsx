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
import { classNames as cx } from '@/lib/format';
import { api, can, useApi, useApiMutation, useMe } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';
import { datasetRelativePrefix, datasetUploadFilename } from './dataset-paths';
import { uploadDatasetFile, abortDatasetUpload, type UploadSession } from '@/lib/multipart-upload';

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
  state?: 'PENDING' | 'READY';
  imported?: boolean;
  selection?: {include?:string[];exclude?:string[]};
  finalizationError?: string;
}

interface S3Entry {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  isPrefix: boolean;
  path?: string;
  versionId?: string;
}

interface S3Listing {
  bucket: string;
  prefix: string;
  entries: S3Entry[];
  nextToken?: string;
  immutable?: boolean;
}

interface LineageData {
  produced: Array<{ version: number; workflowId: string; task: string }>;
  consumers: Array<{ workflowId: string; workflowName: string; task: string; version: 'latest' | number; status: string; inputIndex?:number; workflowDeleted?:boolean }>;
}

export function DatasetDetailPage({ name }: { name: string }) {
  const router = useRouter();
  const me = useMe();
  const t = useT('datasetDetail');
  const tc = useT('common');
  const { ago, fmtNum, fmtBytes } = useFormat();
  const { data, isLoading, error } = useApi<{
    dataset: Dataset;
    versions: DatasetVersion[];
    lineage: LineageData;
  }>(`/api/datasets/${name}`, { refetch: 10000 });

  const [selectedVersion, setSelectedVersion] = React.useState<number>(0);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [fileBrowserPrefix, setFileBrowserPrefix] = React.useState('');
  const [fileBrowserToken, setFileBrowserToken] = React.useState<string | undefined>();
  const [editTagsOpen, setEditTagsOpen] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<Record<string, number>>({});
  const [uploading, setUploading] = React.useState(false);
  const uploadController = React.useRef<AbortController | null>(null);

  const currentVersion = data?.versions.find((v) => v.version === selectedVersion) || data?.versions[0];

  React.useEffect(() => {
    setFileBrowserPrefix('');
    setFileBrowserToken(undefined);
  }, [name, currentVersion?.version]);

  const listingParams = new URLSearchParams({ prefix: fileBrowserPrefix });
  if (fileBrowserToken) listingParams.set('token', fileBrowserToken);
  const fileListingQuery = useApi<S3Listing>(
    currentVersion ? `/api/datasets/${name}/versions/${currentVersion.version}?${listingParams}` : null,
    { refetch: 0 }
  );

  const createVersionMutation = useApiMutation(
    async (input: { uri?: string; note?: string; tags?: string[]; include?:string[];exclude?:string[] }) =>
      api<DatasetVersion>(`/api/datasets/${name}/versions`, { method: 'POST', json: input }),
    [`/api/datasets/${name}`]
  );

  const deleteMutation = useApiMutation(
    async () => api(`/api/datasets/${name}`, { method: 'DELETE' }),
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
  const canUpload = currentVersion?.state === 'PENDING' && !currentVersion.imported && can(me.data, 'researcher');
  const uploadSessions = useApi<UploadSession[]>(canUpload ? `/api/datasets/${name}/versions/${currentVersion.version}/uploads` : null, {refetch: 10000});
  const unfinishedUploads = canUpload ? (uploadSessions.data ?? []).filter(session => !['COMPLETED','ABORTED'].includes(session.state)) : [];
  const uploadEnabled = canUpload && !uploading && !refreshSizeMutation.isPending;
  React.useEffect(() => () => uploadController.current?.abort(), [name, currentVersion?.version]);

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
        include: String(form.get('include') ?? '').split(/\r?\n/).map(p => p.trim()).filter(Boolean),
        exclude: String(form.get('exclude') ?? '').split(/\r?\n/).map(p => p.trim()).filter(Boolean),
        note: form.get('note') as string,
        tags: (form.get('tags') as string).split(',').map((t) => t.trim()).filter(Boolean),
      });
      setSelectedVersion(newVer.version);
      setNewVersionOpen(false);
      setToast({ message: t('toastVersionCreated'), tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create version';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      setDeleteOpen(false);
      setToast({ message: t('toastDatasetDeleted'), tone: 'ok' });
      setTimeout(() => router.push('/datasets'), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete dataset';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const runUploads = async (files: {file: File; filename: string}[], input: HTMLInputElement) => {
    if (!currentVersion || !uploadEnabled) return;
    const version = currentVersion.version;
    const controller = new AbortController(); uploadController.current = controller; setUploading(true);
    try {
      for (const {file, filename} of files) {
        setUploadProgress(previous => ({...previous, [filename]: 0}));
        await uploadDatasetFile(name, version, file, filename, percent => setUploadProgress(previous => ({...previous, [filename]: percent})), controller.signal);
        setUploadProgress(previous => {const next = {...previous}; delete next[filename]; return next;});
      }
      setToast({message:t('uploadComplete'),tone:'ok'});
    } catch (error) {
      setToast({message:controller.signal.aborted ? t('uploadResume') : error instanceof Error ? error.message : t('uploadError'),tone:'err'});
    } finally {
      input.value=''; setUploading(false); uploadController.current=null;
      void uploadSessions.refetch(); void fileListingQuery.refetch();
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void runUploads(Array.from(e.target.files).map(file => ({file, filename: datasetUploadFilename(fileBrowserPrefix, file.name)})), e.target);
  };

  const handleEditTags = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const tagsStr = form.get('tags') as string;
    try {
      await setTagsMutation.mutateAsync(tagsStr.split(',').map((t) => t.trim()).filter(Boolean));
      setEditTagsOpen(false);
      setToast({ message: t('toastTagsUpdated'), tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update tags';
      setToast({ message: msg, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={t('loadingDataset', { name })} />;
  if (!data) return error ? <ErrorBox error={error} /> : <EmptyState title={t('notFound')} />;

  const ds = data.dataset;

  return (
    <>
      <PageHeader title={ds.name} />
      {can(me.data, 'researcher') && (
        <div className="flex gap-2 mb-4">
          <Button onClick={() => setNewVersionOpen(true)}>{t('newVersion')}</Button>
          <Button onClick={() => setDeleteOpen(true)} variant="ghost">{t('deleteDataset')}</Button>
        </div>
      )}

      {error && <ErrorBox error={error} />}
      {refreshSizeMutation.error && <ErrorBox error={refreshSizeMutation.error} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Info */}
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">{tc('description')}</p>
                <p className="text-sm">{ds.description || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">{tc('owner')}</p>
                <p className="text-sm">{ds.owner}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">{tc('created')}</p>
                <p className="text-sm">{ago(ds.createdAt)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">{tc('version')}</p>
                <p className="text-sm mono">v{ds.latestVersion}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 mb-1">{tc('tags')}</p>
                {ds.tags.length === 0 ? (
                  <span className="text-xs text-gray-500">—</span>
                ) : (
                  <div className="flex gap-1 flex-wrap">
                    {ds.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Versions list */}
          <Card>
            <p className="font-semibold text-sm mb-2">{t('versionTitle')} ({data.versions.length})</p>
            {data.versions.length === 0 ? (
              <EmptyState title={t('selectVersion')} hint={t('filesDesc')} />
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
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold">v{v.version}</span>
                      <Badge tone={v.state === 'READY' ? 'ok' : v.state === 'PENDING' ? 'warn' : 'neutral'}>{v.state === 'READY' ? t('stReady') : v.state === 'PENDING' ? t('stPending') : tc('unknown')}</Badge>
                    </div>
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
                  <p className="text-xs font-semibold text-gray-400 mb-1">{t('colState')}</p>
                  <Badge tone={currentVersion.state === 'READY' ? 'ok' : currentVersion.state === 'PENDING' ? 'warn' : 'neutral'}>{currentVersion.state === 'READY' ? t('stReady') : currentVersion.state === 'PENDING' ? t('stPending') : tc('unknown')}</Badge>
                  <p className="text-sm text-fg-muted mt-2">
                    {currentVersion.state === 'PENDING'
                      ? t('pendingDesc')
                      : currentVersion.state === 'READY'
                        ? t('readyDesc')
                        : t('stateUnknownDesc')}
                  </p>
                </div>
                {currentVersion.finalizationError && <ErrorBox error={{ message: t('finalizationError', {error: currentVersion.finalizationError}) }} />}
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">{t('colUri')}</p>
                  <div className="flex items-center gap-2">
                    <code className="mono text-xs bg-bg-elev-2 px-2 py-1 rounded flex-1 break-all">{currentVersion.uri}</code>
                    <CopyButton text={currentVersion.uri} />
                  </div>
                </div>
                {currentVersion.fsxPath && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-1">{tc('path')}</p>
                    <div className="flex items-center gap-2">
                      <code className="mono text-xs bg-bg-elev-2 px-2 py-1 rounded flex-1 break-all">{currentVersion.fsxPath}</code>
                      <CopyButton text={currentVersion.fsxPath} />
                    </div>
                  </div>
                )}
                {currentVersion.selection && ((currentVersion.selection.include?.length ?? 0) > 0 || (currentVersion.selection.exclude?.length ?? 0) > 0) && (
                  <div className="text-sm space-y-1">
                    <p>{t('newVersionInclude')}: <code>{currentVersion.selection.include?.join(', ') || tc('all')}</code></p>
                    <p>{t('newVersionExclude')}: <code>{currentVersion.selection.exclude?.join(', ') || tc('none')}</code></p>
                  </div>
                )}
                {currentVersion.note && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-1">{t('colNote')}</p>
                    <p className="text-sm">{currentVersion.note}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">{tc('created')}</p>
                  <p className="text-sm">{ago(currentVersion.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">{tc('user')}</p>
                  <p className="text-sm">{currentVersion.createdBy}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">{tc('size')}</p>
                  <p className="text-sm">{fmtBytes(currentVersion.sizeBytes)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">{t('colCount')}</p>
                  <p className="text-sm">{currentVersion.objectCount !== undefined ? fmtNum(currentVersion.objectCount) : '—'}</p>
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
                    <Button size="sm" onClick={() => refreshSizeMutation.mutate(undefined, {
                      onSuccess: () => {
                        if (currentVersion.state === 'PENDING') {
                          setToast({ message: t('finalizationRequest', {version: currentVersion.version}), tone: 'ok' });
                        }
                      },
                    })} loading={refreshSizeMutation.isPending} disabled={uploading || unfinishedUploads.length > 0}>
                      {currentVersion.state === 'PENDING' ? t('uploadFinalize') : currentVersion.state === 'READY' ? t('finalizeSizeRefreshLabel') : t('finalizeSizeRefreshLabel')}
                    </Button>
                    <Button size="sm" onClick={() => setEditTagsOpen(true)} variant="ghost">
                      {tc('edit')} {tc('tags')}
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
                title={t('editTagsTitle')}
              >
                <form onSubmit={handleEditTags} className="space-y-4">
                  <Field label={t('editTags')} help={t('editTagsHelp')}>
                    <Input
                      name="tags"
                      defaultValue={currentVersion.tags.join(', ')}
                      placeholder="tag1, tag2"
                    />
                  </Field>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" onClick={() => setEditTagsOpen(false)} variant="ghost">
                      {tc('cancel')}
                    </Button>
                    <Button type="submit" loading={setTagsMutation.isPending}>
                      {tc('save')}
                    </Button>
                  </div>
                </form>
              </Dialog>
            )}

            {/* File browser */}
            <Card>
              <p className="font-semibold text-sm mb-3">{t('filesTitle')}</p>
              {fileListingQuery.isLoading && !fileListingQuery.data && <Spinner label={tc('loadingData')} />}
              {fileListingQuery.error && <ErrorBox error={fileListingQuery.error} />}
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
                      {ds.name} / v{currentVersion.version}
                    </button>
                    {fileBrowserPrefix && (
                      <>
                        <span className="text-gray-500">/</span>
                        {fileBrowserPrefix.split('/').filter(Boolean).map((part, i, arr) => {
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
                    <label className={cx('block p-4 border-2 border-dashed border-gray-600 rounded text-center', uploadEnabled ? 'cursor-pointer hover:border-gray-500' : 'cursor-not-allowed opacity-60')}>
                      <input
                        type="file"
                        multiple
                        disabled={!uploadEnabled}
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                      <div className="text-sm text-gray-400">{uploadEnabled ? t('uploadHintActive') : uploading ? t('uploadingLabel') : t('uploadDisabled')}</div>
                    </label>
                  )}

                  {uploading && <Button size="sm" variant="ghost" onClick={() => uploadController.current?.abort()}>{tc('stop')}</Button>}
                  {unfinishedUploads.length > 0 && <div className="space-y-2 text-sm" aria-live="polite">
                    <p>{t('uploadDesc')}</p>
                    {unfinishedUploads.map(session => <div key={session.id} className="flex items-center justify-between gap-2">
                      <span>{session.filename} · {fmtBytes(session.size)}</span>
                      <label className="text-blue-400 cursor-pointer">{t('uploadResumeLabel')}<input aria-label={`${session.filename} ${t('uploadResumeLabel')}`} type="file" className="hidden" disabled={!uploadEnabled} onChange={event => {
                        const file = event.target.files?.[0]; if (file) void runUploads([{file, filename: session.filename}], event.target);
                      }} /></label>
                      <Button size="sm" variant="ghost" disabled={!uploadEnabled} onClick={async () => {
                        try { await abortDatasetUpload(name, currentVersion.version, session); setUploadProgress(previous => {const next={...previous};delete next[session.filename];return next;}); await uploadSessions.refetch(); }
                        catch(error) {setToast({message:error instanceof Error?error.message:tc('errorGeneric'),tone:'err'});}
                      }}>{t('uploadAbort')}</Button>
                    </div>)}
                  </div>}
                  {uploadSessions.error && <ErrorBox error={uploadSessions.error} />}
                  {/* Upload progress */}
                  {Object.entries(uploadProgress).length > 0 && (
                    <div className="space-y-2">
                      {Object.entries(uploadProgress).map(([name, pct]) => (
                        <div key={name} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span>{name}</span>
                            <span>{pct}%</span>
                          </div>
                          <div role="progressbar" aria-label={`${name} ${t('uploadProgress').replace(/{file}/, name).replace(/{percent}/, pct.toString())}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 bg-gray-700 rounded overflow-hidden">
                            <div style={{ width: `${pct}%` }} className="h-full bg-blue-500 transition-all" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {fileListingQuery.data && <>
                  {/* File table */}
                  {fileListingQuery.data.entries.length === 0 ? (
                    <EmptyState title={t('noFiles')} />
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-border">
                        <tr>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('name')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('size')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('updated')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fileListingQuery.data.entries.map((e) => (
                          <tr key={e.key} className="border-b border-border hover:bg-bg-elev-1 transition">
                            <td className="py-2 px-3">
                              {e.isPrefix ? (
                                <button
                                  onClick={() => {
                                    try {
                                      setFileBrowserPrefix(datasetRelativePrefix(e.key, currentVersion.uri));
                                      setFileBrowserToken(undefined);
                                    } catch (error) {
                                      setToast({ message: error instanceof Error ? error.message : tc('errorLoad'), tone: 'err' });
                                    }
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
                              {!e.isPrefix && fileListingQuery.data.immutable && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    try {
                                      const path = e.path ?? datasetRelativePrefix(e.key, currentVersion.uri);
                                      const res = await api<{ url: string }>(`/api/datasets/${name}/versions/${currentVersion.version}/download?path=${encodeURIComponent(path)}`);
                                      window.open(res.url);
                                    } catch (err) {
                                      const msg = err instanceof Error ? err.message : tc('errorGeneric');
                                      setToast({ message: msg, tone: 'err' });
                                    }
                                  }}
                                >
                                  {tc('download')}
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
                      {tc('next')}
                    </Button>
                  )}
                  </>}
              </div>
            </Card>

            {/* Lineage */}
            {(data.lineage.produced.length > 0 || data.lineage.consumers.length > 0) && (
              <Card>
                <p className="font-semibold text-sm mb-3">{t('lineageTitle')}</p>
                {data.lineage.produced.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-gray-400 mb-2">{t('producedBy')}</p>
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
                    <p className="text-xs font-semibold text-gray-400 mb-2">{t('consumers')}</p>
                    <table className="w-full text-sm">
                      <thead className="border-b border-border">
                        <tr>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('workflow')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('task')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('version')}</th>
                          <th className="py-2 px-3 text-left text-xs font-semibold">{tc('status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lineage.consumers.map((c) => (
                          <tr key={`${c.workflowId}-${c.task}-${c.inputIndex ?? 0}`} className="border-b border-border hover:bg-bg-elev-1 transition">
                            <td className="py-2 px-3">
                              {c.workflowDeleted ? <span>{c.workflowName}</span> : <Link href={`/workflows/${c.workflowId}`} className="text-blue-400 hover:underline text-sm">{c.workflowName}</Link>}
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

          </div>
        )}
      </div>

      {/* New version dialog */}
      {newVersionOpen && (
        <Dialog
          open={newVersionOpen}
          onClose={() => setNewVersionOpen(false)}
          title={t('newVersionTitle')}
        >
          <form onSubmit={handleNewVersion} className="space-y-4">
            <Field label={t('newVersionFrom')}>
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input type="radio" name="choice" value="empty" defaultChecked /> {t('newVersionUpload')}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="choice" value="existing" /> {t('newVersionExisting')}
                </label>
              </div>
            </Field>
            <Field label={t('newVersionUri')} help={t('newVersionUriHelp')}>
              <Input name="uri" placeholder={t('newVersionUriPlaceholder')} />
            </Field>
            <Field label={t('newVersionInclude')} help={t('newVersionIncludeHelp')}>
              <Textarea name="include" rows={3} placeholder={'train/\nlabels.json'} />
            </Field>
            <Field label={t('newVersionExclude')} help={t('newVersionExcludeHelp')}>
              <Textarea name="exclude" rows={3} placeholder={'train/private/'} />
            </Field>
            <Field label={t('newVersionNote')}>
              <Textarea name="note" placeholder={t('newVersionNotePlaceholder')} maxLength={500} rows={3} />
            </Field>
            <Field label={t('newVersionTags')} help={t('editTagsHelp')}>
              <Input name="tags" placeholder="training, processed" />
            </Field>
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={() => setNewVersionOpen(false)} variant="ghost">
                {tc('cancel')}
              </Button>
              <Button type="submit" loading={createVersionMutation.isPending}>
                {tc('create')}
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
          title={t('deleteDataset')}
        >
          <div className="space-y-4">
            <p>{t('deleteConfirm')}</p>
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={() => setDeleteOpen(false)} variant="ghost">
                {tc('cancel')}
              </Button>
              <Button onClick={handleDelete} loading={deleteMutation.isPending}>
                {tc('delete')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
