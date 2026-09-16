import { route } from '@/server/api';
import { allClusters, eksAddons, k8sNodes } from '@/server/services/compute';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const [clusters, nodes, addons] = await Promise.all([allClusters(), k8sNodes().catch(() => []), eksAddons().catch(() => [])]);
  return { clusters, k8sNodes: nodes, addons };
});
