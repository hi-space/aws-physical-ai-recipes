import { route } from '@/server/api';
import { listProjectMembers } from '@/server/auth/project-members';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ session, params }) => ({ members: await listProjectMembers(session, params.id) }));
