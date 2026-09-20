import { body, route } from '@/server/api';
import { projectMetaSchema, resolveProject, updateProjectMeta } from '@/server/auth/projects';
import { deleteProject } from '@/server/auth/project-adoption';
import { projectViews } from '../route';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ session, params }) => (await projectViews(session, [await resolveProject(session, params.id)]))[0]);
export const PATCH = route<{ id: string }>('researcher', async ({ session, params, req }) =>
  (await projectViews(session, [await updateProjectMeta(session, params.id, await body(req, projectMetaSchema))]))[0],
{ audit: 'project.update' });
export const DELETE = route<{ id: string }>('admin', async ({ session, params }) => { await deleteProject(session, params.id); return { ok: true }; }, { audit: 'project.delete' });
