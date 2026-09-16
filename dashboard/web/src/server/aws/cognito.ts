import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  ListGroupsCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../config';
import { notConfigured } from '../errors';
import { cognito } from './clients';

function pool(): string {
  const p = config().cognitoUserPoolId;
  if (!p) throw notConfigured('Cognito user pool');
  return p;
}

export async function listUsers() {
  const out = await cognito().send(new ListUsersCommand({ UserPoolId: pool(), Limit: 60 }));
  const users = out.Users ?? [];
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
