import { qInt, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async ({ url }) => getRepo().listAudit(qInt(url, 'limit', 200)));
