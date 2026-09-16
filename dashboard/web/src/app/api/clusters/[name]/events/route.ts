import { qInt, route } from '@/server/api';
import * as hp from '@/server/aws/hyperpod';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ params, url }) => hp.listEvents(params.name, qInt(url, 'limit', 25)));
