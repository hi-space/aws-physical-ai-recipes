import { posix } from 'node:path';
/** Restricted compiler operands. User code still executes only in its workload container. */
export function assertSafePath(path: string, label = 'path'): void {
  if (!path.startsWith('/') || path === '/' || /[\x00-\x20'"`$\\;]/.test(path) || path.split('/').some(p => p === '..' || p === '.') || path.includes('//')) throw new Error(`unsafe ${label}: ${path}`);
}
export function assertInjectionPath(path: string): void {
  assertSafePath(path, 'file path');
  if (['/pai', '/opt/pai', '/proc', '/sys', '/dev', '/etc', '/bin', '/sbin', '/usr/bin', '/usr/sbin'].some(p => path === p || path.startsWith(p + '/'))) throw new Error(`reserved file path: ${path}`);
}
export function assertEnvironment(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment name ${name}`);
  if (/^(PAI_|OSMO_)/.test(name) || ['MLFLOW_TRACKING_URI', 'MLFLOW_EXPERIMENT_NAME', 'MLFLOW_RUN_NAME', 'PYTHONUNBUFFERED'].includes(name)) throw new Error(`reserved compiler environment ${name}`);
}
export function assertPathWithin(path: string, root: string): void {
  assertSafePath(path);
  assertSafePath(root);
  if (path !== root && !posix.normalize(path).startsWith(root + '/')) throw new Error(`output path must be within ${root}`);
}
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function exitRanges(value: string | number): number[] {
  const codes: number[] = [];
  for (const part of String(value).split(',')) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (!m) throw new Error(`invalid exitActions range ${part}`);
    const start = Number(m[1]),
      end = Number(m[2] ?? m[1]);
    if (start > end || end > 65535) throw new Error(`invalid exitActions range ${part}`);
    for (let code = start; code <= end; code++) codes.push(code);
  }
  return codes;
}
