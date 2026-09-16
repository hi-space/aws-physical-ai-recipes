'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorBox,
  LinkButton,
  Spinner,
  StatusPill,
  Toast,
} from '@/components/ui';
import { ago } from '@/lib/format';
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

interface ModelPackage {
  ModelPackageName: string;
  ModelPackageArn: string;
  ModelPackageStatus: string;
  ModelApprovalStatus: string;
  CreationTime: string;
  ModelPackageVersion?: string;
  ModelPackageGroupName?: string;
}

interface MLFlowVersion {
  version: string;
  current_stage: string;
  run_id?: string;
  status?: string;
  creation_timestamp?: number;
}

interface MLFlowModel {
  name: string;
  latest_versions?: MLFlowVersion[];
}

interface Dataset {
  name: string;
  latestVersion: number;
}

interface ModelsResponse {
  sagemakerModels?: { bucket: string; entries: S3Entry[] };
  eksCheckpoints?: { bucket: string; entries: S3Entry[] };
  modelPackages: ModelPackage[];
  mlflowModels: MLFlowModel[];
  checkpointDatasets: Dataset[];
}

function S3BrowserPopup({ bucket, entry }: { bucket: string; entry: S3Entry }) {
  const [open, setOpen] = React.useState(false);
  const prefix = entry.key;
  const { data: listing, isLoading, refetch } = useApi<S3Listing>(
    open ? `/api/s3?bucket=${bucket}&prefix=${encodeURIComponent(prefix)}` : null,
    { refetch: 0 }
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-mono">{entry.name}</span>
        <div className="flex gap-2">
          <CopyButton text={`s3://${bucket}/${prefix}`} />
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Browse'}
          </Button>
        </div>
      </div>
      {open && (
        <div className="bg-gray-800/50 rounded p-3 text-sm space-y-2">
          {isLoading && <Spinner label="Loading…" />}
          {listing && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {listing.entries.length === 0 ? (
                <p className="text-gray-500">Empty</p>
              ) : (
                listing.entries.map((e) => (
                  <div key={e.key} className="flex justify-between text-xs">
                    <span className="font-mono">{e.name}{e.isPrefix ? '/' : ''}</span>
                    {e.size && <span className="text-gray-500">{e.size} B</span>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelsPage() {
  const { data, isLoading, error } = useApi<ModelsResponse>('/api/models', { refetch: 15000 });
  const [tab, setTab] = React.useState<'sm' | 'eks' | 'registry' | 'mlflow' | 'ckpt'>('sm');

  if (isLoading && !data) return <Spinner label="Loading models…" />;

  return (
    <>
      <PageHeader title="Models" />
      <div className="space-y-4">
        {error && <ErrorBox error={error} />}

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border">
          {(['sm', 'eks', 'registry', 'mlflow', 'ckpt'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                tab === t
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {{
                sm: 'SageMaker fine-tunes',
                eks: 'EKS checkpoints',
                registry: 'Model registry',
                mlflow: 'MLflow models',
                ckpt: 'Checkpoint datasets',
              }[t]}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'sm' && (
          <div className="space-y-4">
            {!data?.sagemakerModels ? (
              <EmptyState title="not_configured" />
            ) : data.sagemakerModels.entries.length === 0 ? (
              <EmptyState title="No fine-tunes" />
            ) : (
              <Card>
                <div className="space-y-3">
                  {data.sagemakerModels.entries
                    .filter((e) => e.isPrefix)
                    .map((e) => (
                      <div key={e.key} className="space-y-2 pb-3 border-b border-border last:border-0 last:pb-0">
                        <S3BrowserPopup bucket={data.sagemakerModels!.bucket} entry={e} />
                        <p className="text-xs text-gray-500">Use as Policy Server: --model-path /mnt/s3/groot/models/groot-sm/{e.name}</p>
                        <LinkButton href={`/edge?modelPath=/mnt/s3/groot/models/groot-sm/${e.name}`} size="sm">
                          Deploy to edge
                        </LinkButton>
                      </div>
                    ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'eks' && (
          <div className="space-y-4">
            {!data?.eksCheckpoints ? (
              <EmptyState title="not_configured" />
            ) : data.eksCheckpoints.entries.length === 0 ? (
              <EmptyState title="No checkpoints" />
            ) : (
              <Card>
                <div className="space-y-3">
                  {data.eksCheckpoints.entries
                    .filter((e) => e.isPrefix)
                    .map((e) => (
                      <div key={e.key} className="space-y-2 pb-3 border-b border-border last:border-0 last:pb-0">
                        <S3BrowserPopup bucket={data.eksCheckpoints!.bucket} entry={e} />
                        <p className="text-xs text-gray-500">FSx path: /fsx/checkpoints/{e.name}</p>
                        <LinkButton href={`/edge?modelPath=/fsx/checkpoints/${e.name}`} size="sm">
                          Deploy to edge
                        </LinkButton>
                      </div>
                    ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'registry' && (
          <div className="space-y-4">
            {!data?.modelPackages || data.modelPackages.length === 0 ? (
              <EmptyState title="No models" />
            ) : (
              <Card>
                <table className="w-full text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Name</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Version</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Status</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Approval</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.modelPackages.map((m) => (
                      <tr key={m.ModelPackageArn} className="border-b border-border hover:bg-bg-elev-1 transition">
                        <td className="py-2 px-3 mono text-sm">{m.ModelPackageName}</td>
                        <td className="py-2 px-3 text-sm">{m.ModelPackageVersion || '—'}</td>
                        <td className="py-2 px-3">
                          <StatusPill status={m.ModelPackageStatus} />
                        </td>
                        <td className="py-2 px-3">
                          <Badge>{m.ModelApprovalStatus}</Badge>
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-500">{ago(m.CreationTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        )}

        {tab === 'mlflow' && (
          <div className="space-y-4">
            {!data?.mlflowModels || data.mlflowModels.length === 0 ? (
              <EmptyState title="No models" />
            ) : (
              <Card>
                <div className="space-y-6">
                  {data.mlflowModels.map((m) => (
                    <div key={m.name} className="space-y-2">
                      <p className="font-semibold">{m.name}</p>
                      {m.latest_versions && m.latest_versions.length > 0 ? (
                        <table className="w-full text-sm">
                          <thead className="border-b border-border">
                            <tr>
                              <th className="py-2 px-3 text-left text-xs font-semibold">Version</th>
                              <th className="py-2 px-3 text-left text-xs font-semibold">Stage</th>
                              <th className="py-2 px-3 text-left text-xs font-semibold">Status</th>
                              <th className="py-2 px-3 text-left text-xs font-semibold">Created</th>
                            </tr>
                          </thead>
                          <tbody>
                            {m.latest_versions.map((v) => (
                              <tr key={v.version} className="border-b border-border hover:bg-bg-elev-1 transition">
                                <td className="py-2 px-3 mono text-sm">{v.version}</td>
                                <td className="py-2 px-3">
                                  <Badge>{v.current_stage}</Badge>
                                </td>
                                <td className="py-2 px-3 text-sm">{v.status || '—'}</td>
                                <td className="py-2 px-3 text-xs text-gray-500">{v.creation_timestamp ? ago(v.creation_timestamp) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="text-xs text-gray-500">No versions</p>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'ckpt' && (
          <div className="space-y-4">
            {!data?.checkpointDatasets || data.checkpointDatasets.length === 0 ? (
              <EmptyState title="No checkpoint datasets" />
            ) : (
              <Card>
                <table className="w-full text-sm">
                  <thead className="border-b border-border">
                    <tr>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Name</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Latest</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.checkpointDatasets.map((d) => (
                      <tr key={d.name} className="border-b border-border hover:bg-bg-elev-1 transition">
                        <td className="py-2 px-3">
                          <Link href={`/datasets/${d.name}`} className="text-blue-400 hover:underline font-mono text-sm">
                            {d.name}
                          </Link>
                        </td>
                        <td className="py-2 px-3 mono text-sm">v{d.latestVersion}</td>
                        <td className="py-2 px-3">
                          <LinkButton href={`/datasets/${d.name}`} size="sm">
                            View
                          </LinkButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
