import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../errors';
import type { Item } from '../store/dynamo';
import { LIMITS, type LogDeps, type LogHead, type LogInput, type LogLease, type LogPage, type LogRecord, type LogScope } from './types';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pad = (value: number) => String(value).padStart(12, '0');
const recordKey = (id: string, seq: number) => ({ pk: `LOG#${id}`, sk: `C#${pad(seq)}` });
export function scopeId(s: LogScope) {
  for (const value of [s.projectId, s.backendId, s.namespace, s.workflowId, s.taskName, s.epoch, s.container, s.podName, s.podUid]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$/.test(value)) throw new HttpError(400, 'Invalid log source identity');
  }
  if (![s.attempt, s.member, s.restartCount].every(Number.isSafeInteger) || s.attempt < 1 || s.member < 0 || s.member > 63 || s.restartCount < 0) throw new HttpError(400, 'Invalid log attempt/member');
  return hash(JSON.stringify([s.projectId, s.backendId, s.backendConfigHash, s.namespace, s.workflowId, s.taskName, s.attempt, s.epoch, s.member, s.container, s.podName, s.podUid, s.restartCount]));
}
const payload = (r: LogInput | LogRecord): LogInput => r.kind === 'data' ? { kind: 'data', data: r.data! } : { kind: 'gap', reason: r.reason! };
export class LogArchive {
  readonly now: () => number;
  constructor(readonly deps: LogDeps) { this.now = deps.now ?? Date.now; }
  async head(id: string): Promise<LogHead> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, 'Invalid log stream');
    const item = await this.deps.repo.kv.get(`LOG#${id}`, 'META');
    if (!item) throw new HttpError(404, 'Log archive not found');
    const h = item as unknown as LogHead;
    if (h.id !== id || scopeId(h.scope) !== id || !Number.isSafeInteger(h.sequence) || h.sequence < 0) throw new HttpError(409, 'Log archive metadata is inconsistent');
    if (h.expiresAt <= this.now()) throw new HttpError(410, 'Log archive retention expired', 'log_retention_expired');
    return { id: h.id, scope: h.scope, sequence: h.sequence, bytes: h.bytes, gaps: h.gaps, state: h.state,
      createdAt: h.createdAt, expiresAt: h.expiresAt, coverage: 'captured-only' };
  }
  async register(scope: LogScope): Promise<LogHead> {
    const id = scopeId(scope), key = { pk: `LOG#${id}`, sk: 'META' };
    const existing = await this.deps.repo.kv.get(key.pk, key.sk);
    if (existing) return this.head(id);
    const head: LogHead = { id, scope, sequence: 0, bytes: 0, gaps: 0, state: 'open', createdAt: new Date(this.now()).toISOString(), expiresAt: this.now() + LIMITS.retentionMs, coverage: 'captured-only' };
    await this.deps.repo.kv.transaction([
      { kind: 'put', item: { ...key, ...head, ttl: Math.ceil(head.expiresAt / 1000) }, condition: { absent: true } },
      { kind: 'put', item: { pk: `WF#${scope.workflowId}`, sk: `LOG#${scope.taskName}#A${pad(scope.attempt)}#${id}`, id, scope, ttl: Math.ceil(head.expiresAt / 1000) }, condition: { absent: true } },
      { kind: 'put', item: { pk: `LOG_POD#${scope.backendId}#${scope.namespace}#${scope.podName}`, sk: id, id, scope, ttl: Math.ceil(head.expiresAt / 1000) }, condition: { absent: true } },
    ]);
    return this.head(id);
  }
  async list(workflowId: string, taskName: string, attempt?: number) {
    const prefix = `LOG#${taskName}#${attempt === undefined ? '' : `A${pad(attempt)}#`}`;
    const rows = await this.deps.repo.kv.query(`WF#${workflowId}`, prefix, { desc: true, limit: 257 });
    const streams: LogHead[] = [];
    for (const row of rows.slice(0, 256)) {
      try { const h = await this.head(String(row.id)); if (h.scope.workflowId !== workflowId || h.scope.taskName !== taskName) throw new HttpError(409, 'Log catalog binding mismatch'); streams.push(h); }
      catch (error) { if (!(error instanceof HttpError && [404, 410].includes(error.status))) throw error; }
    }
    return { streams, truncated: rows.length > 256 };
  }
  async acquire(id: string): Promise<LogLease | undefined> {
    if ((await this.head(id)).state !== 'open') return undefined;
    const key = { pk: `LOG#${id}`, sk: 'LEASE' }, old = await this.deps.repo.kv.get(key.pk, key.sk);
    if (old && Number(old.expiresAt) > this.now()) return undefined;
    const holder = randomUUID();
    const ok = await this.deps.repo.kv.transaction([{ kind: 'put', item: { ...key, holder, expiresAt: this.now() + 15_000 }, condition: old ? { equals: { holder: old.holder, expiresAt: old.expiresAt } } : { absent: true } }]);
    return ok ? { id, holder } : undefined;
  }
  async renew(lease: LogLease) {
    return this.deps.repo.kv.transaction([{ kind: 'put', item: { pk: `LOG#${lease.id}`, sk: 'LEASE', holder: lease.holder, expiresAt: this.now() + 15_000 }, condition: { equals: { holder: lease.holder }, after: { expiresAt: this.now() } } }]);
  }
  async release(lease: LogLease) {
    await this.deps.repo.kv.transaction([{ kind: 'delete', pk: `LOG#${lease.id}`, sk: 'LEASE', condition: { equals: { holder: lease.holder } } }]);
  }
  private check(lease: LogLease) {
    return { kind: 'check' as const, pk: `LOG#${lease.id}`, sk: 'LEASE', condition: { equals: { holder: lease.holder }, after: { expiresAt: this.now() } } };
  }
  private decode(input: LogInput) {
    if (input.kind === 'gap') {
      if (!['source-start', 'source-reconnect', 'source-error', 'source-eof', 'watch-reset', 'pod-gone', 'capture-stop', 'capacity'].includes(input.reason)) throw new HttpError(400, 'Invalid log gap reason');
      return 0;
    }
    if (input.kind !== 'data' || typeof input.data !== 'string') throw new HttpError(400, 'Invalid log record');
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > LIMITS.chunk || bytes.toString('base64') !== input.data) throw new HttpError(413, 'Log chunk exceeds bounds or is malformed');
    return bytes.length;
  }
  async append(lease: LogLease, batchId: string, input: LogInput): Promise<{ record: LogRecord; capped: boolean }> {
    const bytes = this.decode(input), inputHash = hash(JSON.stringify(payload(input)));
    if (!batchId || batchId.length > 256) throw new HttpError(400, 'Invalid log batch identity');
    const receipt = { pk: `LOG#${lease.id}`, sk: `B#${hash(batchId)}` };
    for (let attempt = 0; attempt < 12; attempt++) {
      const prior = await this.deps.repo.kv.get(receipt.pk, receipt.sk);
      if (prior) {
        if (prior.hash !== inputHash) throw new HttpError(409, 'Log batch identity reused with different bytes');
        return { record: await this.record(lease.id, Number(prior.sequence)), capped: prior.capped === true };
      }
      const h = await this.head(lease.id);
      if (h.state === 'capped') throw new HttpError(507, 'Log archive byte cap reached', 'log_archive_capped');
      if (h.state === 'closed') throw new HttpError(409, 'Log archive is sealed', 'log_archive_closed');
      const capped = h.sequence >= 65535 || h.bytes + bytes > (this.deps.maxArchiveBytes ?? LIMITS.archive);
      const data: LogInput = capped ? { kind: 'gap', reason: 'capacity' } : payload(input);
      const record: LogRecord = { sequence: h.sequence + 1, ...data, bytes: capped ? 0 : bytes, hash: hash(JSON.stringify(data)), at: new Date(this.now()).toISOString() };
      const ttl = Math.ceil(h.expiresAt / 1000);
      const ok = await this.deps.repo.kv.transaction([
        this.check(lease),
        { kind: 'put', item: { pk: `LOG#${h.id}`, sk: 'META', ...h, sequence: record.sequence, bytes: h.bytes + record.bytes, gaps: h.gaps + (record.kind === 'gap' ? 1 : 0), state: capped ? 'capped' : 'open', ttl }, condition: { equals: { sequence: h.sequence, state: h.state } } },
        { kind: 'put', item: { ...recordKey(h.id, record.sequence), ...record, ttl }, condition: { absent: true } },
        { kind: 'put', item: { ...receipt, hash: inputHash, sequence: record.sequence, capped, ttl }, condition: { absent: true } },
      ]);
      if (ok) return { record, capped };
      const lock = await this.deps.repo.kv.get(`LOG#${lease.id}`, 'LEASE');
      if (lock?.holder !== lease.holder || Number(lock.expiresAt) <= this.now()) throw new HttpError(409, 'Log capture lease lost');
    }
    throw new HttpError(409, 'Log append contention');
  }
  async close(lease: LogLease) {
    const h = await this.head(lease.id); if (h.state === 'capped') return;
    if (!(await this.deps.repo.kv.transaction([this.check(lease), { kind: 'put', item: { pk: `LOG#${h.id}`, sk: 'META', ...h, state: 'closed', ttl: Math.ceil(h.expiresAt / 1000) }, condition: { equals: { sequence: h.sequence } } }]))) throw new HttpError(409, 'Log close lease lost');
  }
  async record(id: string, sequence: number): Promise<LogRecord> {
    const item = await this.deps.repo.kv.get(recordKey(id, sequence).pk, recordKey(id, sequence).sk) as (Item & LogRecord) | undefined;
    if (!item || item.sequence !== sequence || item.hash !== hash(JSON.stringify(payload(item)))) throw new HttpError(409, 'Committed log record missing or corrupt', 'log_archive_corrupt');
    if (this.decode(payload(item)) !== item.bytes) throw new HttpError(409, 'Log record byte length mismatch');
    return { sequence: item.sequence, ...payload(item), bytes: item.bytes, hash: item.hash, at: item.at };
  }
  async tailStart(id: string, bytes = LIMITS.page): Promise<number> {
    const h = await this.head(id); let next = h.sequence, size = 0, count = 0;
    while (next > 0 && size < bytes && count++ < LIMITS.records) { size += (await this.record(id, next)).bytes; next--; }
    return next;
  }
  async read(id: string, after: number, maxBytes = LIMITS.page): Promise<LogPage> {
    const stream = await this.head(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > stream.sequence || maxBytes < LIMITS.chunk || maxBytes > LIMITS.maxPage) throw new HttpError(400, 'Invalid log replay bounds');
    const records: LogRecord[] = []; let size = 0, next = after;
    while (next < stream.sequence && records.length < LIMITS.records) {
      const record = await this.record(id, next + 1);
      if (size + record.bytes > maxBytes) break;
      records.push(record); size += record.bytes; next++;
    }
    return { stream, records, nextSequence: next, hasMore: next < stream.sequence };
  }
}
