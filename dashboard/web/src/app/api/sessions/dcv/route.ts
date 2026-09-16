import { route } from '@/server/api';
import { config } from '@/server/config';
import { describeWorkstation } from '@/server/aws/ec2-dcv';
import { hyperPodDcvTargets } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const [workstation, nodes] = await Promise.all([config().dcv ? describeWorkstation().catch((e) => ({ error: (e as Error).message })) : undefined, hyperPodDcvTargets()]);
  return { workstation, nodes };
});
