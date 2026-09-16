import { k8sRequest, type K8sRequestInit } from '../k8s/client';
import type { Pod } from '../k8s/resources';
import { HttpError } from '../errors';
import type { LogScope } from './types';
type WatchPod = Pod & { metadata: Pod['metadata'] & { resourceVersion?: string } };
type Requester = (path: string, init?: K8sRequestInit) => Promise<Response>;
export interface Inventory { pods: WatchPod[]; reset: boolean }
const path = (ns: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`;
const unavailable = () => new HttpError(503, 'Log Pod inventory unavailable', 'log_inventory_unavailable');
/** Both HTTP and watch-event 410 discard the old inventory/RV, then perform a fresh list. */
export async function* podInventory(ns: string, selector: string, signal: AbortSignal, request: Requester = k8sRequest): AsyncGenerator<Inventory> {
  let rv: string | undefined, reset = false;
  const pods = new Map<string, WatchPod>();
  while (!signal.aborted) {
    if (!rv) {
      pods.clear();
      let cursor: string | undefined, listRv: string | undefined;
      const seen = new Set<string>();
      do {
        const q = new URLSearchParams({ labelSelector: selector, limit: '200', ...(cursor ? { continue: cursor } : {}) });
        const res = await request(`${path(ns)}?${q}`, { raw: true, signal });
        if (res.status === 410) { await res.body?.cancel(); rv = undefined; reset = true; break; }
        if (!res.ok) { await res.body?.cancel(); throw unavailable(); }
        const data = await boundedJson(res);
        const m = data.metadata as { resourceVersion?: string; continue?: string } | undefined;
        if (!Array.isArray(data.items) || !m?.resourceVersion || listRv && listRv !== m.resourceVersion) throw unavailable();
        listRv = m.resourceVersion;
        for (const pod of data.items as WatchPod[]) {
          if (!pod.metadata?.uid) throw unavailable();
          pods.set(pod.metadata.uid, pod);
          if (pods.size > 1024) throw unavailable();
        }
        cursor = m.continue;
        if (cursor && seen.has(cursor)) throw unavailable();
        if (cursor) seen.add(cursor);
        else rv = listRv;
      } while (cursor && !signal.aborted);
      if (!rv || signal.aborted) continue;
      yield { pods: [...pods.values()], reset }; reset = false;
    }
    const q = new URLSearchParams({ labelSelector: selector, watch: 'true', allowWatchBookmarks: 'true', resourceVersion: rv, timeoutSeconds: '20' });
    const res = await request(`${path(ns)}?${q}`, { raw: true, signal });
    if (res.status === 410) { await res.body?.cancel(); rv = undefined; reset = true; continue; }
    if (!res.ok || !res.body) { await res.body?.cancel(); throw unavailable(); }
    for await (const line of ndjson(res.body)) {
      const event = JSON.parse(line) as { type: string; object: WatchPod & { code?: number } };
      if (event.type === 'ERROR') {
        if (event.object.code !== 410) throw unavailable();
        rv = undefined; reset = true; break;
      }
      const next = event.object?.metadata?.resourceVersion;
      if (!next) throw unavailable();
      if (event.type === 'BOOKMARK') { rv = next; continue; }
      if (!['ADDED', 'MODIFIED', 'DELETED'].includes(event.type) || !event.object.metadata.uid) throw unavailable();
      if (event.type === 'DELETED') pods.delete(event.object.metadata.uid);
      else pods.set(event.object.metadata.uid, event.object);
      if (pods.size > 1024) throw unavailable();
      rv = next;
      yield { pods: [...pods.values()], reset: false };
    }
  }
}
async function boundedJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.body) throw unavailable();
  const reader = res.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4 * 1024 * 1024) throw unavailable(); parts.push(value); }
    return JSON.parse(Buffer.concat(parts).toString());
  } finally { await reader.cancel(); reader.releaseLock(); }
}
async function* ndjson(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder(); let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (value.length > 1024 * 1024) throw unavailable();
      pending += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (line) yield line; }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw unavailable();
    }
    pending += decoder.decode();
    if (pending.trim()) throw unavailable(); // Truncated event must not advance RV.
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function openPodLogStream(s: LogScope, options: { resume: boolean; signal: AbortSignal }) {
  const q = new URLSearchParams({ container: s.container, follow: 'true', timestamps: 'false', ...(options.resume ? { tailLines: '0' } : {}) });
  const res = await k8sRequest(`${path(s.namespace)}/${encodeURIComponent(s.podName)}/log?${q}`, { signal: options.signal, raw: true });
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new HttpError(503, 'Registered Pod log stream unavailable', 'log_source_unavailable'); }
  return res.body;
}
