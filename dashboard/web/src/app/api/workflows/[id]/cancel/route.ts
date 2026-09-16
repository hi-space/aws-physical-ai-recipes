import { route } from '@/server/api';
import { cancelWorkflow } from '@/server/workflow/controller';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session }) => cancelWorkflow(params.id, session.user), { audit: 'workflow.cancel' });
