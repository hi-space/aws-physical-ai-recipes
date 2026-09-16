import { route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const [pipeline, executions] = await Promise.all([sm.describePipeline(), sm.listExecutions(30)]);
  return { pipeline, executions };
});
