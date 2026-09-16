import { route } from '@/server/api';
import { startWorkstation, stopWorkstation, workstationCredentials } from '@/server/aws/ec2-dcv';
import { badRequest } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const POST = route<{ action: string }>('admin', async ({ params }) => {
  if (params.action === 'start') await startWorkstation();
  else if (params.action === 'stop') await stopWorkstation();
  else if (params.action === 'credentials') return workstationCredentials();
  else throw badRequest(`unknown action ${params.action}`);
  return { ok: true };
}, { audit: 'dcv.action' });
