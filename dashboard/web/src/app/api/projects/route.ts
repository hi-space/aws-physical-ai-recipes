import { body, route } from '@/server/api';
import { listProjects, memberRole } from '@/server/auth/projects';
import { adoptInputSchema, adoptProject, attachmentsFor } from '@/server/auth/project-adoption';
import type { ProjectView } from '@/server/auth/project-view';
import { runOnBackend } from '@/server/backends/context';
import type { Session } from '@/server/auth/session';
import type { Project } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';

export async function projectViews(session: Session, projects: Project[]): Promise<ProjectView[]> {
  const attachments = await attachmentsFor(projects);
  return projects.map((project) => ({ ...project, myRole: memberRole(session, project), attachment: attachments.get(project.id) ?? 'UNKNOWN' }));
}
export const GET = route('viewer', async ({ session }) => projectViews(session, await listProjects(session)));
export const POST = route('admin', async ({ req, session }) => {
  const input = await body(req, adoptInputSchema);
  const project = await runOnBackend(input, () => adoptProject(session, input));
  return (await projectViews(session, [project]))[0];
}, { audit: 'project.adopt' });
