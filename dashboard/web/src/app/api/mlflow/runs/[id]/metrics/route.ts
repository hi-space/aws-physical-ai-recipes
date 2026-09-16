import { q, route } from '@/server/api';
import * as ml from '@/server/aws/mlflow';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params, url }) => {
  const keys = (q(url, 'key') ?? '').split(',').filter(Boolean);
  const out: Record<string, unknown> = {};
  await Promise.all(keys.map(async (k) => (out[k] = await ml.getMetricHistory(params.id, k))));
  return out;
});
