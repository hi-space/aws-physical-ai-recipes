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
  finalizationError?: string;
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
  const [uploading, setUploading] = React.useState(false);
  const uploadController = React.useRef<AbortController | null>(null);

  const currentVersion = data?.versions.find((v) => v.version === selectedVersion) || data?.versions[0];

  React.useEffect(() => {
    setFileBrowserPrefix('');
    setFileBrowserToken(undefined);
  }, [name, currentVersion?.version]);

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
  const uploadSessions = useApi<UploadSession[]>(currentVersion?.state === 'PENDING' && can(me.data, 'researcher') ? `/api/datasets/${name}/versions/${currentVersion.version}/uploads` : null, {refetch: 10000});
  const unfinishedUploads = (uploadSessions.data ?? []).filter(session => !['COMPLETED','ABORTED'].includes(session.state));
  const uploadEnabled = currentVersion?.state === 'PENDING' && !uploading && !refreshSizeMutation.isPending;
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
        note: form.get('note') as string,
        tags: (form.get('tags') as string).split(',').map((t) => t.trim()).filter(Boolean),
      });
      setSelectedVersion(newVer.version);
      setNewVersionOpen(false);
      setToast({ message: '버전을 생성했습니다.', tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create version';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync();
      setDeleteOpen(false);
      setToast({ message: '데이터셋을 삭제했습니다.', tone: 'ok' });
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
      setToast({message:'파일 업로드를 확인했습니다. 모두 올린 뒤 버전을 확정하세요.',tone:'ok'});
    } catch (error) {
      setToast({message:controller.signal.aborted ? '일시 중지했습니다. 같은 파일을 다시 선택하면 이어 올립니다.' : error instanceof Error ? error.message : '업로드 실패: 같은 파일을 다시 선택해 재개하세요.',tone:'err'});
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
      setToast({ message: '태그를 변경했습니다.', tone: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update tags';
      setToast({ message: msg, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={`데이터셋 ${name}을 불러오는 중…`} />;
  if (!data) return error ? <ErrorBox error={error} /> : <EmptyState title="데이터셋을 찾을 수 없습니다." />;

  const ds = data.dataset;

  return (
    <>
      <PageHeader title={ds.name} />
      {can(me.data, 'researcher') && (
        <div className="flex gap-2 mb-4">
          <Button onClick={() => setNewVersionOpen(true)}>새 버전</Button>
          <Button onClick={() => setDeleteOpen(true)} variant="ghost">데이터셋 삭제</Button>
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
            <p className="font-semibold text-sm mb-2">버전 ({data.versions.length})</p>
            {data.versions.length === 0 ? (
              <EmptyState title="아직 버전이 없습니다." hint="새 버전을 생성한 뒤 파일을 업로드하세요." />
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
                      <Badge tone={v.state === 'READY' ? 'ok' : v.state === 'PENDING' ? 'warn' : 'neutral'}>{v.state ?? '상태 미확인'}</Badge>
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
                  <p className="text-xs font-semibold text-gray-400 mb-1">버전 상태</p>
                  <Badge tone={currentVersion.state === 'READY' ? 'ok' : currentVersion.state === 'PENDING' ? 'warn' : 'neutral'}>{currentVersion.state ?? '상태 미확인'}</Badge>
                  <p className="text-sm text-fg-muted mt-2">
                    {currentVersion.state === 'PENDING'
                      ? '파일을 여러 번에 나누어 업로드할 수 있습니다. 모두 올린 뒤 검증 및 버전 확정을 누르세요. 확정 상태는 10초마다 갱신됩니다.'
                      : currentVersion.state === 'READY'
                        ? '확정된 버전의 파일은 변경할 수 없습니다. 내용을 바꾸려면 새 버전을 만드세요.'
                        : '버전 상태를 확인할 수 없어 업로드할 수 없습니다.'}
                  </p>
                </div>
                {currentVersion.finalizationError && <ErrorBox error={{ message: `버전 확정 실패: ${currentVersion.finalizationError}` }} />}
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
                    <Button size="sm" onClick={() => refreshSizeMutation.mutate(undefined, {
                      onSuccess: () => {
                        if (currentVersion.state === 'PENDING') {
                          setToast({ message: `v${currentVersion.version} 검증 및 확정 요청을 접수했습니다. READY 상태가 되면 확정이 완료됩니다.`, tone: 'ok' });
                        }
                      },
                    })} loading={refreshSizeMutation.isPending} disabled={uploading || unfinishedUploads.length > 0}>
                      {currentVersion.state === 'PENDING' ? '검증 및 버전 확정' : currentVersion.state === 'READY' ? '확정된 메타데이터 조회' : '메타데이터 조회'}
                    </Button>
                    <Button size="sm" onClick={() => setEditTagsOpen(true)} variant="ghost">
                      태그 편집
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

            {/* File browser */}
            <Card>
              <p className="font-semibold text-sm mb-3">파일</p>
              {fileListingQuery.isLoading && !fileListingQuery.data && <Spinner label="파일을 불러오는 중…" />}
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
                      <div className="text-sm text-gray-400">{uploadEnabled ? '파일 선택 · 같은 파일을 다시 선택하면 이어 올립니다' : uploading ? '파일 업로드 중…' : '파일 업로드 비활성화'}</div>
                    </label>
                  )}

                  {uploading && <Button size="sm" variant="ghost" onClick={() => uploadController.current?.abort()}>일시 중지</Button>}
                  {unfinishedUploads.length > 0 && <div className="space-y-2 text-sm" aria-live="polite">
                    <p>미완료 업로드는 같은 파일로 재개하거나 중단해야 버전을 확정할 수 있습니다.</p>
                    {unfinishedUploads.map(session => <div key={session.id} className="flex items-center justify-between gap-2">
                      <span>{session.filename} · {fmtBytes(session.size)}</span>
                      <label className="text-blue-400 cursor-pointer">이어올리기<input aria-label={`${session.filename} 이어올리기`} type="file" className="hidden" disabled={uploading} onChange={event => {
                        const file = event.target.files?.[0]; if (file) void runUploads([{file, filename: session.filename}], event.target);
                      }} /></label>
                      <Button size="sm" variant="ghost" disabled={uploading} onClick={async () => {
                        try { await abortDatasetUpload(name, currentVersion.version, session); setUploadProgress(previous => {const next={...previous};delete next[session.filename];return next;}); await uploadSessions.refetch(); }
                        catch(error) {setToast({message:error instanceof Error?error.message:'중단 실패',tone:'err'});}
                      }}>업로드 중단</Button>
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
                          <div role="progressbar" aria-label={`${name} 업로드`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1 bg-gray-700 rounded overflow-hidden">
                            <div style={{ width: `${pct}%` }} className="h-full bg-blue-500 transition-all" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* File table */}
                  {fileListingQuery.data.entries.length === 0 ? (
                    <EmptyState title="파일이 없습니다." />
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
                                    try {
                                      setFileBrowserPrefix(datasetRelativePrefix(e.key, currentVersion.uri));
                                      setFileBrowserToken(undefined);
                                    } catch (error) {
                                      setToast({ message: error instanceof Error ? error.message : '폴더를 열 수 없습니다.', tone: 'err' });
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
                                  다운로드
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
                      다음 페이지
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

          </div>
        )}
      </div>

      {/* New version dialog */}
      {newVersionOpen && (
        <Dialog
          open={newVersionOpen}
          onClose={() => setNewVersionOpen(false)}
          title="새 데이터셋 버전"
        >
          <form onSubmit={handleNewVersion} className="space-y-4">
            <Field label="데이터 위치">
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input type="radio" name="choice" value="empty" defaultChecked /> 새 폴더에 업로드
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="choice" value="existing" /> 기존 S3 URI 등록
                </label>
              </div>
            </Field>
            <Field label="URI" help="기존 S3 데이터를 등록할 때 입력하세요.">
              <Input name="uri" placeholder="s3://bucket/prefix/" />
            </Field>
            <Field label="메모">
              <Textarea name="note" placeholder="이 버전의 변경 사항…" maxLength={500} rows={3} />
            </Field>
            <Field label="태그" help="쉼표로 구분하세요.">
              <Input name="tags" placeholder="training, processed" />
            </Field>
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={() => setNewVersionOpen(false)} variant="ghost">
                취소
              </Button>
              <Button type="submit" loading={createVersionMutation.isPending}>
                생성
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
          title="데이터셋 삭제"
        >
          <div className="space-y-4">
            <p>데이터셋 메타데이터와 모든 버전을 삭제합니다.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={deletePurge} onChange={(e) => setDeletePurge(e.target.checked)} />
              <span className="text-sm">datasets/{ds.name}/ 아래 S3 객체도 삭제 (관리자 전용)</span>
            </label>
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={() => setDeleteOpen(false)} variant="ghost">
                취소
              </Button>
              <Button onClick={handleDelete} loading={deleteMutation.isPending}>
                삭제
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
