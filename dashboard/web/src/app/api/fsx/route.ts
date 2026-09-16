import { route } from '@/server/api';
import * as fsx from '@/server/aws/fsx';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => fsx.describeAll());
