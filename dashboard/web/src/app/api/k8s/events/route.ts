import { q, qInt, route } from '@/server/api';
import { listEvents } from '@/server/k8s/resources';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url }) => {
  const evs = await listEvents(q(url, 'ns'), q(url, 'name'), qInt(url, 'limit', 200));
  return evs.filter((e) => !SYSTEM_NAMESPACES.has(e.metadata.namespace ?? '')).map((e) => ({
    ts: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp, type: e.type, reason: e.reason, message: e.message, count: e.count,
    object: `${e.involvedObject?.kind ?? ''}/${e.involvedObject?.name ?? ''}`, namespace: e.metadata.namespace, source: e.source?.component,
  }));
});
