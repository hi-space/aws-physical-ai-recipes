import { route } from '@/server/api';
import { listNamespaces } from '@/server/k8s/resources';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => (await listNamespaces()).map((n) => n.metadata.name).filter((n) => !SYSTEM_NAMESPACES.has(n) && n !== 'default'));
