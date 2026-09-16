import { route } from '@/server/api';
import { retryWorkflow } from '@/server/workflow/controller';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session }) => retryWorkflow(params.id, session.user), { audit: 'workflow.retry' });
