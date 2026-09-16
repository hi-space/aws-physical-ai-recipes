import { route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
import { requestProject } from '@/server/auth/projects';
import { projectPipelineList, PIPELINE_IDENTITY_PARAMETERS } from '@/server/services/pipelines';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) => {
  const project = await requestProject(req, session);
  const legacy = session.role === 'admin' && url.searchParams.get('legacy') === '1';
  const [pipeline, executions] = await Promise.all([sm.describePipeline(), legacy ? sm.listExecutions(30) : projectPipelineList(session, project)]);
  return { pipeline: { ...pipeline,
    projectTrackingSupported: PIPELINE_IDENTITY_PARAMETERS.every(name => pipeline.parameters.some(parameter => parameter.Name === name)),
    parameters: pipeline.parameters.filter(parameter => !PIPELINE_IDENTITY_PARAMETERS.includes(parameter.Name as typeof PIPELINE_IDENTITY_PARAMETERS[number])),
  }, executions };
});
