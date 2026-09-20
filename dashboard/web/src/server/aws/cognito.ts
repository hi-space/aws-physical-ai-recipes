import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListGroupsCommand,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../config';
import { notConfigured } from '../errors';
import { cognito } from './clients';
import { projectAdminGroup, projectGroup } from '../auth/rbac';

function pool(): string {
  const p = config().cognitoUserPoolId;
  if (!p) throw notConfigured('Cognito user pool');
  return p;
}

/** Pages through the whole pool (Cognito's ListUsers caps at 60/page); returns every user. */
export async function listUsers() {
  const users: UserType[] = [];
  let paginationToken: string | undefined;
  const seen = new Set<string>();
  do {
    const out = await cognito().send(new ListUsersCommand({ UserPoolId: pool(), Limit: 60, PaginationToken: paginationToken }));
    users.push(...(out.Users ?? []));
    paginationToken = out.PaginationToken;
    if (paginationToken && seen.has(paginationToken)) throw new Error('Cognito user pagination failed');
    if (paginationToken) seen.add(paginationToken);
  } while (paginationToken);
  return Promise.all(
    users.map(async (u) => {
      const g = await cognito().send(new AdminListGroupsForUserCommand({ UserPoolId: pool(), Username: u.Username! }));
      return {
        username: u.Username!,
        subject: u.Attributes?.find((a) => a.Name === 'sub')?.Value,
        email: u.Attributes?.find((a) => a.Name === 'email')?.Value,
        status: u.UserStatus,
        enabled: u.Enabled,
        created: u.UserCreateDate?.toISOString(),
        groups: (g.Groups ?? []).map((x) => x.GroupName!),
      };
    }),
  );
}
export async function listGroups() {
  const out = await cognito().send(new ListGroupsCommand({ UserPoolId: pool() }));
  return (out.Groups ?? []).map((g) => ({ name: g.GroupName!, description: g.Description }));
}
export async function createUser(username: string, email: string, password: string, group: string) {
  await cognito().send(
    new AdminCreateUserCommand({
      UserPoolId: pool(),
      Username: username,
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
      MessageAction: 'SUPPRESS',
      TemporaryPassword: password,
    }),
  );
  await cognito().send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: username, Password: password, Permanent: true }));
  await cognito().send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: username, GroupName: group }));
}
export async function setPassword(username: string, password: string) {
  await cognito().send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: username, Password: password, Permanent: true }));
}
export async function setGroups(username: string, groups: string[]) {
  const current = await cognito().send(new AdminListGroupsForUserCommand({ UserPoolId: pool(), Username: username }));
  const have = new Set((current.Groups ?? []).map((g) => g.GroupName!));
  for (const g of groups) if (!have.has(g)) await cognito().send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: username, GroupName: g }));
  for (const g of have) if (!groups.includes(g)) await cognito().send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool(), Username: username, GroupName: g }));
}

export interface CurrentUserAuthorization {
  username: string;
  subject: string;
  enabled: boolean;
  groups: string[];
  email: string;
}

/** Fresh authorization lookup for API tokens; deliberately not cached. */
export async function currentUserAuthorization(username: string): Promise<CurrentUserAuthorization> {
  const userPoolId = pool();
  const user = await cognito().send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
  const groups: string[] = [];
  let nextToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await cognito().send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId, Username: user.Username ?? username, Limit: 60, NextToken: nextToken,
    }));
    groups.push(...(page.Groups ?? []).flatMap((group) => group.GroupName ? [group.GroupName] : []));
    nextToken = page.NextToken;
    if (nextToken && seen.has(nextToken)) throw new Error('Cognito group pagination failed');
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return {
    username: user.Username ?? '',
    subject: user.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value ?? '',
    email: user.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value ?? '',
    enabled: user.Enabled === true,
    groups: [...new Set(groups)],
  };
}

const isNamed = (e: unknown, name: string) => (e as { name?: string })?.name === name;
/** Both project groups; GroupExists is fine (re-adoption after a failed transaction). */
export async function createProjectGroups(projectId: string) {
  for (const name of [projectGroup(projectId), projectAdminGroup(projectId)]) {
    try { await cognito().send(new CreateGroupCommand({ UserPoolId: pool(), GroupName: name, Description: `Physical AI dashboard project ${projectId}` })); }
    catch (e) { if (!isNamed(e, 'GroupExistsException')) throw e; }
  }
}
export async function deleteProjectGroups(projectId: string) {
  for (const name of [projectGroup(projectId), projectAdminGroup(projectId)]) {
    try { await cognito().send(new DeleteGroupCommand({ UserPoolId: pool(), GroupName: name })); }
    catch (e) { if (!isNamed(e, 'ResourceNotFoundException')) throw e; }
  }
}
export type ProjectMembership = 'member' | 'project-admin' | null;
/** Touches only this project's two groups; never the platform groups or other projects. */
export async function setProjectGroups(username: string, projectId: string, role: ProjectMembership) {
  const wanted = new Set(role === null ? [] : role === 'member' ? [projectGroup(projectId)] : [projectGroup(projectId), projectAdminGroup(projectId)]);
  const current = new Set((await currentUserAuthorization(username)).groups);
  for (const name of [projectGroup(projectId), projectAdminGroup(projectId)]) {
    if (wanted.has(name) && !current.has(name)) await cognito().send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: username, GroupName: name }));
    if (!wanted.has(name) && current.has(name)) await cognito().send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool(), Username: username, GroupName: name }));
  }
}
