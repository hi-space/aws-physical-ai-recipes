import { randomUUID } from 'node:crypto';
import { LogArchive } from './archive';
import { SecretRedactor } from './redaction';
import { LIMITS, type LogDeps, type LogScope, type LogInput } from './types';
import { HttpError } from '../errors';
export interface CaptureDeps extends LogDeps {
  secrets: string[];
  validate(scope: LogScope): Promise<boolean>;
  finished(scope: LogScope): Promise<boolean>;
  shouldStop?(scope: LogScope): Promise<boolean>;
  open(scope: LogScope, options: { resume: boolean; signal: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
}
/** Only acknowledges committed chunks. A source disconnect is a recorded coverage gap. */
export async function capturePodLogs(scope: LogScope, signal: AbortSignal, deps: CaptureDeps) {
  const redactor = new SecretRedactor(deps.secrets), archive = new LogArchive(deps);
  const head = await archive.register(scope);
  if (head.state !== 'open') return { id: head.id, state: head.state };
  const lease = await archive.acquire(head.id);
  if (!lease) return { id: head.id, state: 'leased' as const };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, renewing = false, leaseError: unknown, capped = false, fenced = false;
  const local = new AbortController(), abort = () => { local.abort(); void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const renew = setInterval(async () => {
    if (renewing) return; renewing = true;
    try {
      if (await deps.shouldStop?.(scope)) { fenced = true; abort(); return; }
      if (!await archive.renew(lease) || !await deps.validate(scope)) throw new HttpError(409, 'Log capture source or lease changed');
    } catch (error) { leaseError = error; local.abort(); void reader?.cancel().catch(() => {}); }
    finally { renewing = false; }
  }, 5000);
  const append = async (input: LogInput) => {
    const batch = randomUUID();
    // Retry the same receipt after ambiguous storage failure. Never change the batch identity.
    try { capped = (await archive.append(lease, batch, input)).capped; }
    catch (error) { if (error instanceof HttpError && error.status < 500) throw error; capped = (await archive.append(lease, batch, input)).capped; }
  };
  const bytes = async (data: Buffer) => {
    for (let i = 0; i < data.length && !capped; i += LIMITS.chunk) await append({ kind: 'data', data: data.subarray(i, i + LIMITS.chunk).toString('base64') });
  };
  let failure: unknown;
  try {
    if (await deps.shouldStop?.(scope)) { fenced = true; abort(); }
    if (!await deps.validate(scope)) throw new HttpError(409, 'Log source identity changed');
    await append({ kind: 'gap', reason: head.sequence ? 'source-reconnect' : 'source-start' });
    if (!capped && !local.signal.aborted) {
      reader = (await deps.open(scope, { resume: head.sequence > 0, signal: local.signal })).getReader();
      if (!await deps.validate(scope)) throw new HttpError(409, 'Log source identity changed during opening');
      while (!local.signal.aborted && !capped) {
        const { done, value } = await reader.read(); if (done) break;
        if (value.length > 1024 * 1024) throw new HttpError(413, 'Source log chunk exceeds capture buffer');
        await bytes(redactor.push(value)); // Storage/backpressure precedes the next read.
      }
      if (leaseError) throw leaseError;
    }
  } catch (error) {
    if (!signal.aborted || leaseError) failure = leaseError ?? error;
  } finally {
    clearInterval(renew); signal.removeEventListener('abort', abort);
    local.abort();
    try {
      if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      if (!capped) {
        // Flush only bytes actually received from the identity-checked stream.
        await bytes(redactor.finish());
        const reason = failure ? 'source-error' : fenced ? 'capture-stop' : signal.aborted
          ? signal.reason === 'watch-reset' ? 'watch-reset' : signal.reason === 'pod-gone' ? 'pod-gone' : 'capture-stop'
          : 'source-eof';
        if (!capped) await append({ kind: 'gap', reason });
        if (!capped && (fenced || signal.aborted && signal.reason !== 'watch-reset' || await deps.finished(scope))) await archive.close(lease);
      }
    } finally { await archive.release(lease); }
  }
  if (failure) throw failure;
  return { id: head.id, state: (await archive.head(head.id)).state };
}
