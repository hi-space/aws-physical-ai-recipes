import { qInt, route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
import { tailStream } from '@/server/aws/logs';
import { config } from '@/server/config';
import { requestProject } from '@/server/auth/projects';
import { assertTrainingJobAccess } from '@/server/services/pipelines';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ req, session, params, url }) => {
  await assertTrainingJobAccess(session, await requestProject(req, session), params.name);
  const [job, logs] = await Promise.all([
    sm.describeTrainingJob(params.name),
    tailStream(config().groot?.trainingLogGroup ?? '/aws/sagemaker/TrainingJobs', `${params.name}/`, qInt(url, 'tail', 300)).catch((e) => [{ ts: Date.now(), message: `no logs: ${(e as Error).message}` }]),
  ]);
  return { job, logs };
});
