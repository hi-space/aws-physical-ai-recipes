import { route } from '@/server/api';
import * as ml from '@/server/aws/mlflow';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => ml.searchExperiments());
