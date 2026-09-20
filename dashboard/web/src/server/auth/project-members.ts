import { badRequest } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Session } from './session';
import { projectRoleFromGroups, type ProjectRole } from './rbac';
import { resolveProject } from './projects';
import * as cognito from '../aws/cognito';

export interface ProjectMember { username: string; subject?: string; email?: string; role: ProjectRole }
export interface MembersDeps {
  repo: Repo;
  listUsers(): Promise<Array<{ username: string; subject?: string; email?: string; groups: string[] }>>;
  setProjectGroups(username: string, projectId: string, role: cognito.ProjectMembership): Promise<void>;
}
const productionDeps = (): MembersDeps => ({ repo: getRepo(), listUsers: cognito.listUsers, setProjectGroups: cognito.setProjectGroups });
const usernamePattern = /^[\p{L}\p{N}_.@+-]{1,128}$/u;

export async function listProjectMembers(session: Session, id: string, deps: MembersDeps = productionDeps()): Promise<ProjectMember[]> {
  await resolveProject(session, id, deps.repo, 'project-admin');
  return (await deps.listUsers()).flatMap((user) => {
    const role = projectRoleFromGroups(user.groups, id);
    return role ? [{ username: user.username, subject: user.subject, email: user.email, role }] : [];
  });
}
export async function setProjectMembership(session: Session, id: string, username: string, role: cognito.ProjectMembership, deps: MembersDeps = productionDeps()): Promise<void> {
  await resolveProject(session, id, deps.repo, 'project-admin');
  if (!usernamePattern.test(username)) throw badRequest('Invalid username');
  try {
    await deps.setProjectGroups(username, id, role);
  } catch (e) {
    if ((e as { name?: string })?.name === 'UserNotFoundException') throw badRequest('Unknown Cognito username');
    throw e;
  }
}
