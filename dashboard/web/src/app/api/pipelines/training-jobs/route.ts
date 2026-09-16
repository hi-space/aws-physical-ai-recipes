import { q, qInt, route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async ({ url }) => sm.listTrainingJobs(qInt(url, 'max', 25), q(url, 'contains')));
