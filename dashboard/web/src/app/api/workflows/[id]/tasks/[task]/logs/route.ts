import { route } from '@/server/api';
import { taskLogResponse } from '@/server/logs/http';
export const dynamic = 'force-dynamic';
/** Reads the task's current Pod through the Kubernetes API; nothing is stored. Pod deletion ends log availability. */
export const GET = route<{ id: string; task: string }>('viewer', async ({ params, req, session }) =>
  taskLogResponse(req, session, params.id, params.task));
