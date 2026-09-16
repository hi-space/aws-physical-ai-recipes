import type { Repo } from '../store/repo';
import type { CurrentUserAuthorization } from '../aws/cognito';
export const LIMITS = { chunk: 16 * 1024, page: 64 * 1024, maxPage: 256 * 1024, records: 64, archive: 64 * 1024 * 1024, retentionMs: 30 * 86400_000, cursorMs: 3600_000 } as const;
export interface LogScope {
  projectId: string; backendId: string; backendConfigHash?: string; namespace: string;
  workflowId: string; taskName: string; attempt: number; epoch: string; member: number;
  container: string; podName: string; podUid: string; restartCount: number;
}
export type GapReason = 'source-start' | 'source-reconnect' | 'source-error' | 'source-eof' | 'watch-reset' | 'pod-gone' | 'capture-stop' | 'capacity';
export type LogInput = { kind: 'data'; data: string } | { kind: 'gap'; reason: GapReason };
export interface LogRecord { sequence: number; kind: 'data' | 'gap'; data?: string; reason?: GapReason; bytes: number; hash: string; at: string }
export interface LogHead { id: string; scope: LogScope; sequence: number; bytes: number; gaps: number; state: 'open' | 'closed' | 'capped'; createdAt: string; expiresAt: number; coverage: 'captured-only' }
export interface LogLease { id: string; holder: string }
export interface LogDeps { repo: Repo; now?: () => number; currentUser?: (username: string) => Promise<CurrentUserAuthorization>; maxArchiveBytes?: number }
export interface LogPage { stream: LogHead; records: LogRecord[]; nextSequence: number; hasMore: boolean }
