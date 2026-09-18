'use client';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, ErrorBox, Segmented, Spinner } from '@/components/ui';
import { api, useApi } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { useT, type Translator } from '@/lib/i18n';
import type { ArtifactFile, ArtifactVersion, WorkflowArtifacts } from '@/server/services/workflow-artifacts';
import type { PreviewKind } from '@/server/data/artifact-preview';

/**
 * Stage 1 of "see the simulation from the dashboard": every file a task published (open-loop plots,
 * rollout videos, evaluation.json, model cards) rendered inline from its pinned S3 version. URLs are
 * presigned per file for 5 minutes through the same verified download path the Datasets page uses.
 */
interface ArtifactViewerProps { workflowId: string; selectedTask?: string; onSelectTask?: (name?: string) => void; running: boolean }
interface Selected { version: ArtifactVersion; task: string; file: ArtifactFile }
interface SignedFile { url: string; size: number; kind: PreviewKind }
type Filter = 'all' | 'media' | 'reports' | 'other';
type T = Translator<'artifacts'>;

const FILTERS: { id: Filter; label: 'filterAll' | 'filterMedia' | 'filterReports' | 'filterOther'; match: (kind: PreviewKind) => boolean }[] = [
  { id: 'all', label: 'filterAll', match: () => true },
  { id: 'media', label: 'filterMedia', match: (k) => k === 'image' || k === 'video' },
  { id: 'reports', label: 'filterReports', match: (k) => k === 'json' || k === 'text' },
  { id: 'other', label: 'filterOther', match: (k) => k === 'other' },
];
const GALLERY_PAGE = 12;
const KIND_TONE: Record<PreviewKind, 'info' | 'accent' | 'ok' | 'neutral'> = { image: 'accent', video: 'accent', json: 'info', text: 'info', other: 'neutral' };

export function signedFileUrl(version: ArtifactVersion, path: string, inline: boolean): Promise<SignedFile> {
  return api<SignedFile>(`/api/datasets/${encodeURIComponent(version.dataset)}/versions/${version.version}/download?path=${encodeURIComponent(path)}&inline=${inline ? '1' : '0'}`);
}

/** Presigned URL fetched on mount; a failed load (expired URL) refreshes it once. */
function useSignedUrl(version: ArtifactVersion, path: string, t: T) {
  const [state, setState] = useState<{ url?: string; error?: string; attempt: number }>({ attempt: 0 });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ attempt: s.attempt }));
    signedFileUrl(version, path, true)
      .then((r) => { if (!cancelled) setState((s) => ({ ...s, url: r.url })); })
      .catch((e) => { if (!cancelled) setState((s) => ({ ...s, error: e instanceof Error ? e.message : t('previewUrlUnavailable') })); });
    return () => { cancelled = true; };
  }, [version.dataset, version.version, version.manifestHash, path, state.attempt]);
  const retry = () => setState((s) => (s.attempt < 1 ? { attempt: s.attempt + 1 } : { ...s, error: t('downloadFailed') }));
  return { ...state, retry };
}

/** Gallery tiles crop extreme aspect ratios (tall open-loop plots, wide strips) so they stay legible; the preview shows the full image. */
export function thumbnailFit(width: number, height: number): string {
  if (!width || !height) return 'object-contain';
  const ratio = height / width;
  if (ratio > 2) return 'object-cover object-top';
  if (ratio < 1 / 3) return 'object-cover object-left';
  return 'object-contain';
}

function Media({ version, path, kind, className, autoPlay, thumbnail }: { version: ArtifactVersion; path: string; kind: PreviewKind; className?: string; autoPlay?: boolean; thumbnail?: boolean }) {
  const t = useT('artifacts');
  const { url, error, retry } = useSignedUrl(version, path, t);
  const [fit, setFit] = useState('object-contain');
  if (error) return <div className={`flex items-center justify-center bg-bg-elev-2 p-2 text-center text-xs text-fg-muted ${className ?? ''}`}>{error}</div>;
  if (!url) return <div className={`flex items-center justify-center bg-bg-elev-2 ${className ?? ''}`}><Spinner label={t('previewLoadingUrl')} /></div>;
  if (kind === 'video') return <video className={className} src={url} controls preload="metadata" autoPlay={autoPlay} muted loop playsInline onError={retry} aria-label={path} />;
  return <img className={`${className ?? ''} ${thumbnail ? fit : ''}`} src={url} alt={path} loading="lazy" onError={retry}
    onLoad={(e) => { if (thumbnail) setFit(thumbnailFit(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)); }} />;
}

function TextPreview({ version, file }: { version: ArtifactVersion; file: ArtifactFile }) {
  const t = useT('artifacts');
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setText(undefined); setError(undefined);
    signedFileUrl(version, file.path, true)
      .then(async (r) => {
        const res = await fetch(r.url);
        if (!res.ok) throw new Error(t('downloadFailed'));
        const raw = await res.text();
        if (cancelled) return;
        if (file.kind === 'json') { try { setText(JSON.stringify(JSON.parse(raw), null, 2)); return; } catch { /* fall through: show raw */ } }
        setText(raw);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('downloadFailed')); });
    return () => { cancelled = true; };
  }, [version.dataset, version.version, version.manifestHash, file.path, file.kind]);
  if (error) return <ErrorBox error={{ message: error }} />;
  if (text === undefined) return <Spinner label={t('previewLoading')} />;
  return <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-3 font-mono text-[13px] leading-5 text-fg">{text}</pre>;
}

function Preview({ selected }: { selected: Selected }) {
  const t = useT('artifacts');
  const { version, file, task } = selected;
  const open = async (inline: boolean) => {
    try { const r = await signedFileUrl(version, file.path, inline); window.open(r.url, '_blank', 'noopener'); }
    catch { /* toast-free: the file list still shows the error state on next selection */ }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={KIND_TONE[file.kind]}>{file.kind}</Badge>
        <span className="break-all font-mono">{file.path}</span>
        <span className="text-fg-muted">{fmtBytes(file.bytes)}</span>
        <span className="text-fg-muted">· {task} → <a className="text-accent hover:underline" href={`/datasets/${version.dataset}`}>{version.dataset}</a> v{version.version}</span>
        <span className="ml-auto flex gap-1">
          {file.previewable && <Button size="sm" variant="ghost" onClick={() => open(true)}>{t('openNew')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => open(false)}>{t('downloadFile')}</Button>
        </span>
      </div>
      {file.kind === 'image' || file.kind === 'video'
        ? <Media key={file.path} version={version} path={file.path} kind={file.kind} autoPlay className="max-h-[70vh] w-full rounded-md border border-border bg-black object-contain" />
        : file.previewable
          ? <TextPreview key={file.path} version={version} file={file} />
          : <EmptyState title={t('noPreview')} hint={t('downloadHint', { size: fmtBytes(file.bytes) })} />}
    </div>
  );
}

export function ArtifactViewer({ workflowId, selectedTask, onSelectTask, running }: ArtifactViewerProps) {
  const t = useT('artifacts');
  const { data, error, isLoading } = useApi<WorkflowArtifacts>(`/api/workflows/${workflowId}/artifacts`, { refetch: running ? 15_000 : 0 });
  const [mode, setMode] = useState<'gallery' | 'files'>('gallery');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Selected>();
  const [galleryLimit, setGalleryLimit] = useState(GALLERY_PAGE);

  const tasks = useMemo(() => (data?.tasks ?? []).filter((item) => !selectedTask || item.task === selectedTask), [data, selectedTask]);
  const match = FILTERS.find((f) => f.id === filter)!.match;
  const entries = useMemo(() => tasks.flatMap((item) => item.versions.flatMap((v) => v.files.filter((f) => match(f.kind)).map((file): Selected => ({ task: item.task, version: v, file })))), [tasks, match]);
  const media = useMemo(() => entries.filter((e) => e.file.kind === 'image' || e.file.kind === 'video'), [entries]);
  useEffect(() => { if (mode === 'gallery' && media.length === 0 && entries.length > 0) setMode('files'); }, [mode, media.length, entries.length]);

  if (isLoading) return <Spinner label={t('loading')} />;
  if (error) return <ErrorBox error={error} />;
  if (!data || data.tasks.length === 0) {
    return <EmptyState title={t('noArtifacts')} hint={running ? t('noArtifactsRunning') : t('noArtifactsDeclared')} />;
  }
  const unavailable = tasks.flatMap((item) => item.versions.filter((v) => v.state !== 'ready').map((v) => ({ task: item.task, version: v })));

  return (
    <div className="space-y-4" data-testid="artifact-viewer">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-fg-muted">{t('summary', { files: data.fileCount.toLocaleString(), media: data.mediaCount, tasks: data.tasks.length })}</span>
        {selectedTask && <Button size="sm" variant="ghost" onClick={() => onSelectTask?.(undefined)}>{t('clearTask', { task: selectedTask })} ✕</Button>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.id, label: t(f.label) }))} />
          <Segmented value={mode} onChange={setMode} options={[{ value: 'gallery', label: t('modeGallery') }, { value: 'files', label: t('modeFiles') }]} />
        </span>
      </div>

      {unavailable.map(({ task, version }) => (
        <div key={`${task}:${version.dataset}:${version.version}`} className="rounded-md border border-border bg-bg-elev-2 px-3 py-2 text-[13px] text-fg-muted">
          <span className="font-medium text-fg">{task}</span> → <a className="text-accent hover:underline" href={`/datasets/${version.dataset}`}>{version.dataset}</a> v{version.version}: {version.message}
        </div>
      ))}

      {mode === 'gallery' && (
        media.length === 0
          ? <EmptyState title={t('noMedia')} hint={t('noMediaHint')} action={<Button size="sm" onClick={() => setMode('files')}>{t('modeFiles')}</Button>} />
          : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {media.slice(0, galleryLimit).map((e) => (
                  <figure key={`${e.task}:${e.version.dataset}:${e.file.path}`} className="overflow-hidden rounded-md border border-border bg-bg-elev">
                    <button className="block w-full" onClick={() => { setSelected(e); setMode('files'); }} title={t('viewFullSize')}>
                      <Media version={e.version} path={e.file.path} kind={e.file.kind} thumbnail className="h-48 w-full bg-black" />
                    </button>
                    <figcaption className="flex items-center gap-2 px-2.5 py-2 text-xs">
                      <Badge tone="neutral">{e.task}</Badge>
                      <span className="truncate font-mono" title={e.file.path}>{e.file.path}</span>
                      <span className="ml-auto shrink-0 text-fg-muted">{fmtBytes(e.file.bytes)}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
              {media.length > galleryLimit && <Button variant="ghost" size="sm" className="w-full" onClick={() => setGalleryLimit((n) => n + GALLERY_PAGE)}>{t('showMore', { remaining: media.length - galleryLimit })}</Button>}
            </div>
          )
      )}

      {mode === 'files' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(260px,1fr)_2fr]">
          <div className="max-h-[75vh] overflow-auto rounded-md border border-border">
            {tasks.map((item) => item.versions.filter((v) => v.state === 'ready').map((v) => {
              const files = v.files.filter((f) => match(f.kind));
              return (
                <div key={`${item.task}:${v.dataset}:${v.version}`}>
                  <div className="sticky top-0 flex items-center gap-2 border-b border-border bg-bg-elev px-3 py-2 text-xs">
                    <button className="font-medium text-fg hover:underline" onClick={() => onSelectTask?.(item.task)}>{item.task}</button>
                    <a className="text-accent hover:underline" href={`/datasets/${v.dataset}`}>{v.dataset}</a>
                    <span className="text-fg-muted">v{v.version} · {v.fileCount} · {fmtBytes(v.sizeBytes)}</span>
                    {v.truncated && <Badge tone="warn">{t('topShown', { count: v.files.length })}</Badge>}
                  </div>
                  {files.length === 0 && <div className="px-3 py-2 text-xs text-fg-muted">{t('noFilesMatch')}</div>}
                  {files.map((f) => {
                    const active = selected?.file.path === f.path && selected.version.dataset === v.dataset && selected.version.version === v.version;
                    return (
                      <button key={f.path} onClick={() => setSelected({ task: item.task, version: v, file: f })}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-bg-elev-2 ${active ? 'bg-accent/15' : ''}`}>
                        <Badge tone={KIND_TONE[f.kind]} className="w-14 justify-center">{f.kind}</Badge>
                        <span className="truncate font-mono" title={f.path}>{f.path}</span>
                        <span className="ml-auto shrink-0 text-fg-muted">{fmtBytes(f.bytes)}</span>
                      </button>
                    );
                  })}
                </div>
              );
            }))}
          </div>
          <div className="min-w-0 rounded-md border border-border p-3">
            {selected ? <Preview selected={selected} /> : <EmptyState title={t('selectFile')} hint={t('selectFileHint')} />}
          </div>
        </div>
      )}
    </div>
  );
}
