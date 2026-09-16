import { route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
export const dynamic = 'force-dynamic';
export const GET = route<{ arn: string }>('viewer', async ({ params }) => sm.describeExecution(decodeURIComponent(params.arn)));
