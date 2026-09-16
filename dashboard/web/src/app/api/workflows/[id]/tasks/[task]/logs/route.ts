import { route } from '@/server/api';
import { taskLogResponse } from '@/server/logs/http';
export const dynamic = 'force-dynamic';
/** Captured history survives Pod deletion; opaque positions resume the exact committed stream. */
export const GET = route<{ id: string; task: string }>('viewer', async ({ params, req, session }) =>
  taskLogResponse(req, session, params.id, params.task));
