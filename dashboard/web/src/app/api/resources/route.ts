import { route } from '@/server/api';
import { listTaggedResources } from '@/server/aws/tagged-resources';
export const dynamic = 'force-dynamic';
/** Read-only inventory of AWS resources carrying the deployment's resource tag (cached 60 s server-side). */
export const GET = route('viewer', async () => listTaggedResources());
