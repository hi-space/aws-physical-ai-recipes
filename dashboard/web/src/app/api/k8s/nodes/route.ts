import { route } from '@/server/api';
import { k8sNodes } from '@/server/services/compute';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => k8sNodes());
