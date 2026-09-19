import type { Repo } from '../store/repo';
import type { CurrentUserAuthorization } from '../aws/cognito';
export const LIMITS = { chunk: 16 * 1024, tailDefault: 1000, tailMax: 5000, snapshotBytes: 1024 * 1024, followMs: 55_000 } as const;
export interface LogTarget { namespace: string; podName: string; podUid: string; attempt: number; member: number; containers: string[]; phase?: string }
export interface LogLine { ts: string; text: string }
export interface LogSnapshot {
  source: 'kubernetes' | 'none'; reason?: 'pod-gone' | 'not-started'; phase?: string;
  target?: LogTarget; container?: string; targets: LogTarget[]; lines: LogLine[]; truncated: boolean;
  redaction: 'applied' | 'unavailable' | 'none';
}
export interface LogDeps { repo: Repo; now?: () => number; currentUser?: (username: string) => Promise<CurrentUserAuthorization> }
