'use client';
import * as React from 'react';
import { Button, CopyButton, EmptyState, ErrorBox, Spinner, Table } from '@/components/ui';
import { ago, fmtBytes, classNames as cx } from '@/lib/format';
import { api, useApi } from '@/lib/api-client';

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

export interface S3BrowserProps {
  bucket: string;
  initialPrefix?: string;
  allowUpload?: boolean;
  allowDelete?: boolean;
}

export function S3Browser({ bucket, initialPrefix = '', allowUpload = false, allowDelete = false }: S3BrowserProps) {
  const [prefix, setPrefix] = React.useState(initialPrefix);
  const [token, setToken] = React.useState<string | undefined>();
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [uploadProgress, setUploadProgress] = React.useState<Record<string, number>>({});
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const { data, isLoading, error, refetch } = useApi<S3Listing>(
    `/api/s3?bucket=${bucket}&prefix=${encodeURIComponent(prefix)}&token=${token ?? ''}`,
    { refetch: 0 }
  );

  const handleFolderClick = (folderKey: string) => {
    setPrefix(folderKey);
    setToken(undefined);
    setSelected(new Set());
  };

  const handleBreadcrumbClick = (newPrefix: string) => {
    setPrefix(newPrefix);
    setToken(undefined);
    setSelected(new Set());
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!allowUpload || !e.target.files) return;
    const files = Array.from(e.target.files);

    for (const file of files) {
      try {
        setUploadProgress((p) => ({ ...p, [file.name]: 0 }));

        const presignRes = await api<{ url: string }>('/api/s3/presign', {
          method: 'POST',
          json: { bucket, key: prefix + file.name, op: 'put', contentType: file.type },
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

    refetch();
    e.target.value = '';
  };

  const handleDelete = async () => {
    try {
      const keys = Array.from(selected);
      await api('/api/s3', { method: 'DELETE', json: { bucket, keys } });
      setToast({ message: `Deleted ${keys.length} file(s)`, tone: 'ok' });
      setSelected(new Set());
      setDeleteConfirm(false);
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      setToast({ message: msg, tone: 'err' });
    }
  };

  const isEksDataBucket = bucket.includes('eks') || bucket.includes('data');
  const showFsxPath = isEksDataBucket && (prefix.startsWith('datasets/') || prefix.startsWith('checkpoints/'));
  const fsxPath = showFsxPath ? `/fsx/${prefix.replace(/\/$/, '')}` : null;

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <button
          onClick={() => handleBreadcrumbClick('')}
          className="text-blue-400 hover:underline"
        >
          {bucket}
        </button>
        {prefix && (
          <>
            <span className="text-gray-500">/</span>
            {prefix.split('/').filter(Boolean).map((part, i, arr) => {
              const newPrefix = arr.slice(0, i + 1).join('/') + '/';
              return (
                <React.Fragment key={i}>
                  <button
                    onClick={() => handleBreadcrumbClick(newPrefix)}
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

      {/* FSx mirror path */}
      {fsxPath && (
        <div className="bg-blue-900/20 border border-blue-700 rounded p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">FSx mirror: <code className="mono">{fsxPath}</code></span>
            <CopyButton text={fsxPath} />
          </div>
        </div>
      )}

      {/* Upload area */}
      {allowUpload && (
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

      {isLoading && !data ? (
        <Spinner label="Loading…" />
      ) : !data || data.entries.length === 0 ? (
        <EmptyState title="No files" />
      ) : (
        <>
          {/* Selection and delete toolbar */}
          {allowDelete && selected.size > 0 && (
            <div className="flex items-center justify-between bg-blue-900/20 border border-blue-700 rounded p-2">
              <span className="text-sm">{selected.size} selected</span>
              {deleteConfirm ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setDeleteConfirm(false)} variant="ghost">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleDelete} variant="danger">
                    Confirm delete
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setDeleteConfirm(true)} variant="danger">
                  Delete selected
                </Button>
              )}
            </div>
          )}

          {/* File table */}
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                {allowDelete && <th className="py-2 px-3 text-left w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === data.entries.length && data.entries.length > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelected(new Set(data.entries.map((e) => e.key)));
                      } else {
                        setSelected(new Set());
                      }
                    }}
                  />
                </th>}
                <th className="py-2 px-3 text-left text-xs font-semibold">Name</th>
                <th className="py-2 px-3 text-left text-xs font-semibold">Size</th>
                <th className="py-2 px-3 text-left text-xs font-semibold">Modified</th>
                <th className="py-2 px-3 text-left text-xs font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.key} className="border-b border-border hover:bg-bg-elev-1 transition">
                  {allowDelete && (
                    <td className="py-2 px-3">
                      <input
                        type="checkbox"
                        checked={selected.has(e.key)}
                        onChange={(ev) => {
                          const next = new Set(selected);
                          if (ev.target.checked) next.add(e.key);
                          else next.delete(e.key);
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  <td className="py-2 px-3">
                    {e.isPrefix ? (
                      <button
                        onClick={() => handleFolderClick(e.key)}
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
                              json: { bucket, key: e.key, op: 'get' },
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

          {/* Load more */}
          {data.nextToken && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setToken(data.nextToken)}
              className="w-full"
            >
              Load more
            </Button>
          )}
        </>
      )}

      {toast && (
        <div className={cx(
          'p-3 rounded text-sm',
          toast.tone === 'ok' ? 'bg-green-900/20 text-green-300' : 'bg-red-900/20 text-red-300'
        )}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
