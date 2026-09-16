import { route } from '@/server/api';
import * as ml from '@/server/aws/mlflow';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const [run, artifacts] = await Promise.all([ml.getRun(params.id), ml.listArtifacts(params.id).catch(() => [])]);
  return { run, artifacts };
});
