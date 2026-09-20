import { describe, expect, it } from 'vitest';
import { projectAdminGroup, projectGroup, projectRoleFromGroups, roleFromGroups } from './rbac';

describe('projectRoleFromGroups', () => {
  it('names groups with the proj- prefix', () => {
    expect(projectGroup('team-a')).toBe('proj-team-a');
    expect(projectAdminGroup('team-a')).toBe('proj-team-a-admin');
  });
  it('returns undefined for non-members regardless of platform role', () => {
    expect(projectRoleFromGroups(['admins'], 'team-a')).toBeUndefined();
    expect(projectRoleFromGroups(['researchers', 'proj-team-b'], 'team-a')).toBeUndefined();
    expect(projectRoleFromGroups(undefined, 'team-a')).toBeUndefined();
  });
  it('composes the member group with the platform role', () => {
    expect(projectRoleFromGroups(['proj-team-a'], 'team-a')).toBe('viewer');
    expect(projectRoleFromGroups(['viewers', 'proj-team-a'], 'team-a')).toBe('viewer');
    expect(projectRoleFromGroups(['researchers', 'proj-team-a'], 'team-a')).toBe('researcher');
    expect(projectRoleFromGroups(['admins', 'proj-team-a'], 'team-a')).toBe('researcher');
  });
  it('grants project-admin from the admin group alone, even for a platform viewer', () => {
    expect(projectRoleFromGroups(['proj-team-a-admin'], 'team-a')).toBe('project-admin');
    expect(projectRoleFromGroups(['viewers', 'proj-team-a-admin'], 'team-a')).toBe('project-admin');
    expect(projectRoleFromGroups(['researchers', 'proj-team-a', 'proj-team-a-admin'], 'team-a')).toBe('project-admin');
  });
  it('does not confuse prefixed ids', () => {
    expect(projectRoleFromGroups(['proj-team-a-admin'], 'team-a-admin')).toBeUndefined();
    expect(projectRoleFromGroups(['proj-team-ab'], 'team-a')).toBeUndefined();
    // Explicit rule: project ids ending in "-admin" always resolve to undefined
    expect(projectRoleFromGroups(['proj-x-admin', 'proj-x-admin-admin'], 'x-admin')).toBeUndefined();
  });
  it('keeps the platform mapping', () => {
    expect(roleFromGroups(['proj-team-a', 'researchers'])).toBe('researcher');
  });
});
