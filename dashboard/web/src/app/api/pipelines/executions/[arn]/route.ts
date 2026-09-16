import { route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
import { forbidden } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const GET = route<{ arn: string }>('viewer', async ({ params }) => {
  const arn = decodeURIComponent(params.arn);
  if (!/^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:pipeline\/[A-Za-z0-9-]+\/execution\/[A-Za-z0-9-]+$/.test(arn) || !arn.includes(`:pipeline/${sm.pipelineName()}/execution/`)) {
    throw forbidden('execution does not belong to the dashboard pipeline');
  }
  return sm.describeExecution(arn);
});
