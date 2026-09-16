import { route } from '@/server/api';
import * as hp from '@/server/aws/hyperpod';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string; nodeId: string }>('viewer', async ({ params }) => (await hp.describeNode(params.name, params.nodeId)).NodeDetails);
