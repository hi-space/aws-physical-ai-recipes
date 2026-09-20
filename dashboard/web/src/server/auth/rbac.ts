export type Role = 'admin' | 'researcher' | 'viewer';

const RANK: Record<Role, number> = { viewer: 0, researcher: 1, admin: 2 };

/** Cognito group → role. Unknown groups are ignored; no group = viewer. */
export function roleFromGroups(groups: readonly string[] | undefined): Role {
  if (!groups) return 'viewer';
  if (groups.includes('admins')) return 'admin';
  if (groups.includes('researchers')) return 'researcher';
  return 'viewer';
}

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'researcher' || v === 'viewer';
}

export type ProjectRole = 'viewer' | 'researcher' | 'project-admin';
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, researcher: 1, 'project-admin': 2 };
export const projectGroup = (projectId: string) => `proj-${projectId}`;
export const projectAdminGroup = (projectId: string) => `proj-${projectId}-admin`;
export function isProjectRole(v: unknown): v is ProjectRole {
  return v === 'viewer' || v === 'researcher' || v === 'project-admin';
}
/**
 * Project role = project group × platform group. `proj-<id>-admin` alone grants project-admin
 * (member management) even to a platform viewer; execution paths still gate on the platform role.
 * Project ids ending in "-admin" always resolve to undefined.
 */
export function projectRoleFromGroups(groups: readonly string[] | undefined, projectId: string): ProjectRole | undefined {
  if (!groups) return undefined;
  // Ids ending in "-admin" are rejected at adoption (projectIdPattern): "proj-<x>-admin" could not otherwise be told apart from the member group of a project named "<x>-admin".
  if (projectId.endsWith('-admin')) return undefined;
  if (groups.includes(projectAdminGroup(projectId))) return 'project-admin';
  if (!groups.includes(projectGroup(projectId))) return undefined;
  return roleFromGroups(groups) === 'viewer' ? 'viewer' : 'researcher';
}
