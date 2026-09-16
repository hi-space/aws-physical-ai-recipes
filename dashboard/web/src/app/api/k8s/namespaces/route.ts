import { route } from '@/server/api';
import { listNamespaces } from '@/server/k8s/resources';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
import { listProjects } from '@/server/auth/projects';
import { currentBackend } from '@/server/backends/context';
import { backendId } from '@/server/backends/registry';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session }) => {
  if (session.role !== 'admin') return (await listProjects(session)).filter(project => backendId(project.backendId) === (currentBackend()?.id ?? 'default')).map((project) => project.namespace);
  return (await listNamespaces()).map((n) => n.metadata.name).filter((n) => !SYSTEM_NAMESPACES.has(n) && n !== 'default');
});
