import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { assertTrainingJobAccess } from '@/server/services/pipelines';
import { stopPipelineTrainingJob } from '@/server/aws/training-jobs';
export const dynamic = 'force-dynamic';
/** StopTrainingJob for one pipeline-created job; the pipeline step then fails and the execution stops on its own. */
export const POST = route<{ name: string }>('researcher', async ({ req, session, params }) => {
  await assertTrainingJobAccess(session, await requestProject(req, session), params.name);
  await stopPipelineTrainingJob(params.name);
  return { ok: true, trainingJobName: params.name, requestedAt: new Date().toISOString() };
}, { audit: 'training-job.stop' });
