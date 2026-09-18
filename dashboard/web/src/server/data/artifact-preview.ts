/**
 * Classification shared by the workflow Artifacts viewer (API + UI). Kinds decide how the browser
 * renders a pinned object; content types are sent as S3 response overrides because FSx→S3 exports
 * arrive as binary/octet-stream, which <img>/<video> refuse to play.
 */
export type PreviewKind = 'image' | 'video' | 'json' | 'text' | 'other';

const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
const VIDEO: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const TEXT: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
  py: 'text/x-python', sh: 'text/x-shellscript', toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain', html: 'text/plain',
};

/** Inline text/JSON previews are fetched into the browser; anything larger is download-only. */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
/** Files listed per published version; the manifest keeps the full set. */
export const MAX_LISTED_FILES = 2000;

const extension = (path: string) => path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';

export function previewKind(path: string): PreviewKind {
  const ext = extension(path);
  if (ext in IMAGE) return 'image';
  if (ext in VIDEO) return 'video';
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return 'json';
  if (ext in TEXT) return 'text';
  return 'other';
}

export function contentTypeFor(path: string): string {
  const ext = extension(path);
  if (ext in IMAGE) return IMAGE[ext];
  if (ext in VIDEO) return VIDEO[ext];
  if (ext === 'json') return 'application/json';
  if (ext === 'ndjson' || ext === 'jsonl') return 'application/x-ndjson';
  if (ext in TEXT) return `${TEXT[ext]}; charset=utf-8`;
  return 'application/octet-stream';
}

/** Whether the UI may fetch this object into the page (media are streamed by the browser instead). */
export function inlinePreviewable(path: string, bytes: number): boolean {
  const kind = previewKind(path);
  if (kind === 'image' || kind === 'video') return true;
  return (kind === 'json' || kind === 'text') && bytes <= MAX_INLINE_TEXT_BYTES;
}
