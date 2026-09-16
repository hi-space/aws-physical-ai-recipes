import { route } from '@/server/api';
import { runUsage } from '@/server/services/usage';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params, session }) => runUsage(params.id, session));
