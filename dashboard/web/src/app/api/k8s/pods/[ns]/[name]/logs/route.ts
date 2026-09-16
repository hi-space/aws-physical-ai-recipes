import { q, qInt, route, sse } from '@/server/api';
import { getPod, podLogs, streamPodLogs } from '@/server/k8s/resources';
import { podLogsFromCloudWatch } from '@/server/aws/logs';
export const dynamic = 'force-dynamic';
export const GET = route<{ ns: string; name: string }>('viewer', async ({ params, url, req }) => {
  const tail = qInt(url, 'tail', 1000);
  const pod = await getPod(params.ns, params.name);
  if (!pod) {
    const cw = await podLogsFromCloudWatch(params.ns, params.name, tail).catch(() => []);
    return { source: 'cloudwatch', lines: cw.map((l) => `${new Date(l.ts).toISOString()} ${l.message}`) };
  }
  if (q(url, 'follow') === '1' && pod.status?.phase === 'Running') {
    const reader = (await streamPodLogs(params.ns, params.name, { tailLines: tail })).getReader();
    const dec = new TextDecoder();
    async function* gen() {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        if (parts.length) yield { data: parts };
      }
      if (buf) yield { data: [buf] };
      yield { event: 'end', data: {} };
    }
    return sse(gen(), req.signal);
  }
  try {
    const text = await podLogs(params.ns, params.name, { tailLines: tail, container: q(url, 'container') });
    return { source: 'kubernetes', phase: pod.status?.phase, lines: text.split('\n').filter(Boolean) };
  } catch (e) {
    return { source: 'kubernetes', phase: pod.status?.phase, lines: [`no logs: ${(e as Error).message}`] };
  }
});
