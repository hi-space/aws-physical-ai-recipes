import { badRequest } from '../errors';
export interface PathSelection { include?: string[]; exclude?: string[] }
/** Exact relative files, or directory prefixes ending in '/'. No implicit glob dialect. */
export function safeDataPath(path: string): boolean {
  return typeof path === 'string' && !!path && Buffer.byteLength(path) <= 1024 && !/^[\/]/.test(path) && !/[\\\x00-\x1f\x7f*?%]/.test(path)
    && path.split('/').every(p => !!p && p !== '.' && p !== '..' && p !== '.pai' && !p.startsWith('.pai-input-'))
    && path !== 'manifest.json' && path !== '.dataset.json';
}
export function normalizeSelection(input: PathSelection = {}): Required<PathSelection> {
  const clean = (paths: string[] | undefined) => {
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > 128)) throw badRequest('Use at most 128 include/exclude paths');
    return [...new Set((paths ?? []).map(path => {
      if (typeof path !== 'string' || !safeDataPath(path.endsWith('/') ? path.slice(0,-1) : path) || path.includes('://')) throw badRequest('Selection paths must be safe relative files or directory prefixes; glob patterns are not supported');
      return path;
    }))].sort();
  };
  return {include:clean(input.include),exclude:clean(input.exclude)};
}
export function pathSelected(path: string, selection: PathSelection): boolean {
  const matches = (p: string) => p.endsWith('/') ? path.startsWith(p) : path === p;
  return (!(selection.include?.length) || selection.include.some(matches)) && !selection.exclude?.some(matches);
}
