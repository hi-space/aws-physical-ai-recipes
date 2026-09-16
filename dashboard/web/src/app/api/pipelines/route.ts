import { route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
import { requestProject } from '@/server/auth/projects';
import { projectPipelineList } from '@/server/services/pipelines';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) => {
  const project = await requestProject(req, session);
  const legacy = session.role === 'admin' && url.searchParams.get('legacy') === '1';
  const [pipeline, executions] = await Promise.all([sm.describePipeline(), legacy ? sm.listExecutions(30) : projectPipelineList(session, project)]);
  return { pipeline, executions };
});
