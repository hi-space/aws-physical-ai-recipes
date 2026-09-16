import { q, qInt, route } from '@/server/api';
import * as ml from '@/server/aws/mlflow';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url }) => {
  const exp = q(url, 'experiment');
  if (!exp) throw new Error('experiment required');
  return ml.searchRuns(exp.split(','), q(url, 'filter') ?? '', qInt(url, 'max', 100));
});
