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
