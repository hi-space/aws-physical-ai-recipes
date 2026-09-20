'use client';
import { useEffect, useState } from 'react';
import { EmptyState, ErrorBox, Spinner } from '@/components/ui';
import { api } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { useT, type Translator } from '@/lib/i18n';
import type { PreviewKind } from '@/server/data/artifact-preview';

/**
 * Inline file preview shared by the workflow Artifacts viewer and the Datasets file browser. Both
 * speak the same verified, presigned datasets download path: `inline=1` asks S3 to serve the object
 * with a real content type and `Content-Disposition: inline` so the browser renders it instead of
 * downloading. Only immutable (pinned) versions expose this endpoint, so callers gate on that.
 */
export interface PreviewRef { dataset: string; version: number; manifestHash?: string }
export interface PreviewFile { path: string; kind: PreviewKind; bytes: number; previewable: boolean }
interface SignedFile { url: string; size: number; kind: PreviewKind }
type T = Translator<'artifacts'>;

export function signedFileUrl(ref: PreviewRef, path: string, inline: boolean): Promise<SignedFile> {
  return api<SignedFile>(`/api/datasets/${encodeURIComponent(ref.dataset)}/versions/${ref.version}/download?path=${encodeURIComponent(path)}&inline=${inline ? '1' : '0'}`);
}

/** Presigned URL fetched on mount; a failed load (expired URL) refreshes it once. */
function useSignedUrl(ref: PreviewRef, path: string, t: T) {
  const [state, setState] = useState<{ url?: string; error?: string; attempt: number }>({ attempt: 0 });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ attempt: s.attempt }));
    signedFileUrl(ref, path, true)
      .then((r) => { if (!cancelled) setState((s) => ({ ...s, url: r.url })); })
      .catch((e) => { if (!cancelled) setState((s) => ({ ...s, error: e instanceof Error ? e.message : t('previewUrlUnavailable') })); });
    return () => { cancelled = true; };
  }, [ref.dataset, ref.version, ref.manifestHash, path, state.attempt]);
  const retry = () => setState((s) => (s.attempt < 1 ? { attempt: s.attempt + 1 } : { ...s, error: t('downloadFailed') }));
  return { ...state, retry };
}

export function Media({ refPin, path, kind, className, autoPlay, thumbnail, fit: fitClass }: { refPin: PreviewRef; path: string; kind: PreviewKind; className?: string; autoPlay?: boolean; thumbnail?: boolean; fit?: (w: number, h: number) => string }) {
  const t = useT('artifacts');
  const { url, error, retry } = useSignedUrl(refPin, path, t);
  const [fit, setFit] = useState('object-contain');
  if (error) return <div className={`flex items-center justify-center bg-bg-elev-2 p-2 text-center text-xs text-fg-muted ${className ?? ''}`}>{error}</div>;
  if (!url) return <div className={`flex items-center justify-center bg-bg-elev-2 ${className ?? ''}`}><Spinner label={t('previewLoadingUrl')} /></div>;
  if (kind === 'video') return <video className={className} src={url} controls preload="metadata" autoPlay={autoPlay} muted loop playsInline onError={retry} aria-label={path} />;
  return <img className={`${className ?? ''} ${thumbnail ? fit : ''}`} src={url} alt={path} loading="lazy" onError={retry}
    onLoad={(e) => { if (thumbnail && fitClass) setFit(fitClass(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)); }} />;
}

export function TextPreview({ refPin, file }: { refPin: PreviewRef; file: PreviewFile }) {
  const t = useT('artifacts');
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setText(undefined); setError(undefined);
    signedFileUrl(refPin, file.path, true)
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
  }, [refPin.dataset, refPin.version, refPin.manifestHash, file.path, file.kind]);
  if (error) return <ErrorBox error={{ message: error }} />;
  if (text === undefined) return <Spinner label={t('previewLoading')} />;
  return <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-3 font-mono text-[13px] leading-5 text-fg">{text}</pre>;
}

/** Renders a single file inline, choosing media vs. text vs. a download-only hint from its kind. */
export function InlineFilePreview({ refPin, file }: { refPin: PreviewRef; file: PreviewFile }) {
  const t = useT('artifacts');
  if (file.kind === 'image' || file.kind === 'video') {
    return <Media key={file.path} refPin={refPin} path={file.path} kind={file.kind} className="max-h-[70vh] w-full rounded-md border border-border bg-black object-contain" />;
  }
  if (file.previewable) return <TextPreview key={file.path} refPin={refPin} file={file} />;
  return <EmptyState title={t('noPreview')} hint={t('downloadHint', { size: fmtBytes(file.bytes) })} />;
}
