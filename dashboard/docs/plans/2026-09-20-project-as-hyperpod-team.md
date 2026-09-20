# Project = HyperPod Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a dashboard project a thin adoption of a SageMaker HyperPod `ComputeQuota` (id = TeamName, namespace/queue derived) and move project membership from the DynamoDB `members` map to Cognito groups `proj-<id>` / `proj-<id>-admin`.

**Architecture:** `Session` gains `groups` (carried in the ALB Cognito access-token claim → `x-pai-groups`). `projects.ts` keeps the `Project` type and all *read-side* authorization (`memberRole` and friends replace every `project.members[...]` read). A new `project-adoption.ts` owns the SageMaker/Cognito/DynamoDB adoption transaction, deletion, and the cached ATTACHED/DETACHED computation; `project-members.ts` owns member listing/editing via Cognito groups. Token/gateway/log auth paths compute the project role from the freshly fetched `user.groups` they already hold.

**Tech Stack:** Next.js 16 route handlers (`route()` wrapper in `src/server/api.ts`), zod, `@aws-sdk/client-sagemaker`, `@aws-sdk/client-cognito-identity-provider`, DynamoDB single table via `repo.kv` (`MemoryKV` in tests), vitest (`npm test`), `tsc --noEmit` (`npm run typecheck`), Playwright browser tests (`*.browser.test.ts`), CDK (`infra/`).

**Spec:** `dashboard/docs/designs/2026-09-20-project-as-hyperpod-team-design.md`

## Global Constraints

- All paths below are relative to `dashboard/web/` unless prefixed with `infra/` or `docs/`.
- Project id regex stays `^[a-z][a-z0-9-]{0,39}$`; TeamNames that do not match are rejected at adoption.
- Namespace is always `hyperpod-ns-<id>`; LocalQueue is always `hyperpod-ns-<id>-localqueue`. Never persist `namespace`/`queue`/`members` on `PROJECT#<id>/META`.
- Cognito group names: `proj-<id>` (member), `proj-<id>-admin` (project admin). Platform groups `admins`/`researchers`/`viewers` are unchanged.
- Never read `project.members` anywhere after Task 7. Use `memberRole` / `isMember` / `canWriteIn` / `isProjectAdmin` (session paths) or `projectRoleFromGroups(user.groups, projectId)` (token/gateway/log paths).
- Hot path (`requestProject`, `resolveProject`, `canReadResource`, `filterAccessible`) must not call SageMaker or Cognito.
- New user-visible strings go into `src/lib/i18n/messages/*.ts` in **both** `en` and `ko`.
- Commit after each task. Commit message style: `feat(dashboard): …` / `refactor(dashboard): …` / `test(dashboard): …` / `docs(dashboard): …`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `web/AGENTS.md` warns this Next.js differs from training data; route handler shape used here (`route(minRole, handler, {audit})`) is the existing repo convention — copy it, don't invent.
- Run tests from `dashboard/web`: `npx vitest run <file>` for one file, `npm test` for all, `npm run typecheck` for TypeScript.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/auth/rbac.ts` (modify) | Platform role + **project role from groups**, group name helpers |
| `src/server/auth/session.ts` (modify) | `Session.groups`, `x-pai-groups` header |
| `src/proxy.ts` (modify) | Fill `x-pai-groups` on all four auth paths; `DEV_GROUPS` |
| `src/server/auth/api-tokens.ts` (modify) | Membership from `user.groups`; `TokenSession.groups` |
| `src/server/auth/projects.ts` (rewrite) | `Project` type, derived namespace/queue, `memberRole` family, read-side auth helpers, meta update |
| `src/server/auth/project-adoption.ts` (create) | `adoptProject`, `deleteProject`, `attachmentsFor` (SageMaker + Cognito + kv transaction) |
| `src/server/auth/project-members.ts` (create) | `listProjectMembers`, `setProjectMembership` via Cognito groups |
| `src/server/auth/session.test-helpers.ts` (create) | `testSession`, `projectFixture`, `putProject` for tests |
| `src/server/aws/cognito.ts` (modify) | `createProjectGroups`, `deleteProjectGroups`, `setProjectGroups` |
| `src/server/aws/hyperpod.ts` (modify) | `describeComputeQuota` |
| `src/app/api/projects/route.ts` (rewrite) | GET list (+`myRole`, `attachment`), POST adopt |
| `src/app/api/projects/[id]/route.ts` (rewrite) | GET, PATCH meta, DELETE |
| `src/app/api/projects/[id]/members/route.ts` (create) | GET members |
| `src/app/api/projects/[id]/members/[username]/route.ts` (create) | PUT membership |
| ~20 call sites (Task 7) | Replace `members` reads |
| `src/components/pages/ProjectsPage.tsx` (rewrite) | Adopt team, attachment badge, members panel, delete |
| `src/components/pages/SessionsPage.tsx`, `ProjectSwitcher.tsx`, `QueuesPage.tsx`, `backend-ui.ts` (modify) | `myRole`, DETACHED marker, project column |
| `src/lib/i18n/messages/projects.ts`, `queues.ts`, `nav.ts` (modify) | ko/en strings |
| `infra/lib/dashboard-stack.ts` (modify) | Cognito group IAM actions |
| `docs/runbooks/2026-09-20-project-reset.md` (create) | Deployed-environment reset steps |

---

### Task 1: Project role from Cognito groups (`rbac.ts`)

**Files:**
- Modify: `src/server/auth/rbac.ts`
- Test: `src/server/auth/rbac.test.ts` (create)

**Interfaces:**
- Produces: `type ProjectRole = 'viewer' | 'researcher' | 'project-admin'`, `PROJECT_ROLE_RANK: Record<ProjectRole, number>`, `projectGroup(id): string`, `projectAdminGroup(id): string`, `projectRoleFromGroups(groups: readonly string[] | undefined, projectId: string): ProjectRole | undefined`, `isProjectRole(v): v is ProjectRole`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/auth/rbac.test.ts
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
  });
  it('keeps the platform mapping', () => {
    expect(roleFromGroups(['proj-team-a', 'researchers'])).toBe('researcher');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/rbac.test.ts`
Expected: FAIL — `projectRoleFromGroups is not a function` (module has no such export).

- [ ] **Step 3: Implement**

Append to `src/server/auth/rbac.ts`:

```ts
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
 */
export function projectRoleFromGroups(groups: readonly string[] | undefined, projectId: string): ProjectRole | undefined {
  if (!groups) return undefined;
  if (groups.includes(projectAdminGroup(projectId))) return 'project-admin';
  if (!groups.includes(projectGroup(projectId))) return undefined;
  return roleFromGroups(groups) === 'viewer' ? 'viewer' : 'researcher';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/auth/rbac.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/rbac.ts src/server/auth/rbac.test.ts
git commit -m "feat(dashboard): derive project role from Cognito proj-<id> groups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Groups ride in the session (`session.ts`, `proxy.ts`, `api-tokens.ts` return)

**Files:**
- Modify: `src/server/auth/session.ts`
- Modify: `src/proxy.ts:50-57, 71-75, 108-112, 130-136`
- Modify: `src/server/auth/api-tokens.ts:13-15, 162-163`
- Test: `src/server/auth/session.test.ts` (create)

**Interfaces:**
- Produces: `Session.groups?: string[]` (undefined ⇒ treated as `[]`), `SESSION_HEADERS.groups = 'x-pai-groups'`, `TokenSession.groups: string[]`.
- Env: `DEV_GROUPS` (comma-separated, default `admins`) replaces `DEV_ROLE`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/auth/session.test.ts
import { describe, expect, it } from 'vitest';
import { SESSION_HEADERS, sessionFromHeaders } from './session';

const base = { [SESSION_HEADERS.user]: 'alice', [SESSION_HEADERS.subject]: 'sub-a', [SESSION_HEADERS.role]: 'researcher' };
describe('sessionFromHeaders groups', () => {
  it('parses the comma-separated groups header', () => {
    const s = sessionFromHeaders(new Headers({ ...base, [SESSION_HEADERS.groups]: 'researchers,proj-team-a,' }));
    expect(s.groups).toEqual(['researchers', 'proj-team-a']);
  });
  it('defaults to an empty list when the header is absent', () => {
    expect(sessionFromHeaders(new Headers(base)).groups).toEqual([]);
  });
  it('exposes the header name for proxy.ts', () => {
    expect(SESSION_HEADERS.groups).toBe('x-pai-groups');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/session.test.ts`
Expected: FAIL — `SESSION_HEADERS.groups` is undefined / `groups` not on session.

- [ ] **Step 3: Implement session.ts**

In `src/server/auth/session.ts`:

```ts
export interface Session {
  user: string;
  subject?: string;
  email: string;
  role: Role;
  /** Cognito groups of the caller (platform + proj-* groups). Absent in legacy fixtures ⇒ no project membership. */
  groups?: string[];
  authMethod?: 'alb' | 'cognito' | 'token';
  tokenProjectId?: string;
  scopes?: string[];
  tokenId?: string;
}

export const SESSION_HEADERS = {
  user: 'x-pai-user',
  subject: 'x-pai-subject',
  email: 'x-pai-email',
  role: 'x-pai-role',
  groups: 'x-pai-groups',
  authMethod: 'x-pai-auth-method',
  tokenProjectId: 'x-pai-token-project',
  scopes: 'x-pai-token-scopes',
  tokenId: 'x-pai-token-id',
} as const;

export const parseGroupsHeader = (value: string | null) => (value ?? '').split(',').map((g) => g.trim()).filter(Boolean);
```

and in `sessionFromHeaders` add `groups: parseGroupsHeader(h.get(SESSION_HEADERS.groups)),` right after `role, authMethod,`.

- [ ] **Step 4: Implement proxy.ts**

Token branch (after `headers.set(SESSION_HEADERS.role, principal.role);`):
```ts
      headers.set(SESSION_HEADERS.groups, principal.groups.join(','));
```
Dev branch — replace the `role` line:
```ts
    const devGroups = (process.env.DEV_GROUPS ?? 'admins').split(',').map((g) => g.trim()).filter(Boolean);
    headers.set(SESSION_HEADERS.role, roleFromGroups(devGroups));
    headers.set(SESSION_HEADERS.groups, devGroups.join(','));
```
Cognito branch (after the `role` line):
```ts
    headers.set(SESSION_HEADERS.groups, identity.groups.join(','));
```
ALB branch (after the `role` line):
```ts
    headers.set(SESSION_HEADERS.groups, groups.join(','));
```
Update the header comment at the top: `In dev mode (AUTH_MODE=dev) the caller carries DEV_GROUPS (default: admins).`

- [ ] **Step 5: Implement TokenSession.groups**

In `src/server/auth/api-tokens.ts` change the interface:
```ts
export interface TokenSession extends Session {
  subject: string; role: 'viewer' | 'researcher'; groups: string[]; tokenProjectId: string; authMethod: 'token'; scopes: ApiScope[]; tokenId: string;
}
```
and the return in `verifyApiToken`:
```ts
    return { user: user.username, subject: user.subject, email: user.email, role, groups: user.groups, tokenProjectId: record.projectId, authMethod: 'token',
      scopes: record.scopes.filter((scope) => role !== 'viewer' || !scope.endsWith(':write')), tokenId: record.id };
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/server/auth/session.test.ts src/server/auth/api-tokens.test.ts && npm run typecheck`
Expected: session tests PASS; api-tokens tests still PASS (groups is additive); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth/session.ts src/server/auth/session.test.ts src/proxy.ts src/server/auth/api-tokens.ts
git commit -m "feat(dashboard): carry Cognito groups in the session (x-pai-groups, DEV_GROUPS)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: AWS wrappers — Cognito project groups, `describeComputeQuota`

**Files:**
- Modify: `src/server/aws/cognito.ts`
- Modify: `src/server/aws/hyperpod.ts`

**Interfaces:**
- Produces: `createProjectGroups(projectId): Promise<void>` (idempotent), `deleteProjectGroups(projectId): Promise<void>` (idempotent), `setProjectGroups(username, projectId, role: 'member' | 'project-admin' | null): Promise<void>`, `describeComputeQuota(id): Promise<DescribeComputeQuotaResponse>`.

These are thin SDK wrappers with no local logic worth unit-testing in isolation (the repo tests none of `cognito.ts`); they are exercised through the adoption tests in Task 5 via injected deps.

- [ ] **Step 1: Cognito wrappers**

In `src/server/aws/cognito.ts` extend the import and add functions:

```ts
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
} from '@aws-sdk/client-cognito-identity-provider';
import { projectAdminGroup, projectGroup } from '../auth/rbac';
```

```ts
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
```

- [ ] **Step 2: HyperPod wrapper**

In `src/server/aws/hyperpod.ts` add after `listComputeQuotas`:

```ts
export async function describeComputeQuota(id: string) {
  return sagemaker().send(new DescribeComputeQuotaCommand({ ComputeQuotaId: id }));
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/aws/cognito.ts src/server/aws/hyperpod.ts
git commit -m "feat(dashboard): Cognito project-group wrappers and DescribeComputeQuota

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `projects.ts` rewrite — type, derived fields, `memberRole` family, read-side helpers

**Files:**
- Rewrite: `src/server/auth/projects.ts`
- Create: `src/server/auth/session.test-helpers.ts`
- Rewrite: `src/server/auth/projects.test.ts`

**Interfaces:**
- Consumes: `projectRoleFromGroups`, `PROJECT_ROLE_RANK`, `ProjectRole` (Task 1); `Session.groups` (Task 2).
- Produces (all exported from `projects.ts`):
  - `interface Project { id; name; computeQuotaId; clusterArn; backendId?; backendConfigHash?; namespace; queue; credentialRefs; description?; createdAt; updatedAt }`
  - `projectIdPattern`, `namespaceOf(p)`, `queueOf(p)`, `projectIdFromNamespace(ns): string | undefined`
  - `projectFromItem(item): Project`, `projectItem(project): Item` (strips namespace/queue, adds pk/sk/gsi keys)
  - `memberRole(session, {id}): ProjectRole | undefined`, `isMember`, `canWriteIn`, `isProjectAdmin`
  - `getProject(id, repo?)`, `listAllProjects(repo?)`, `listProjects(session, repo?)`, `resolveProject(session, id?, repo?, required?)`, `requestProject(req, session, required?)`
  - `projectMetaSchema`, `updateProjectMeta(session, id, input, repo?)`
  - `canReadResource`, `assertResourceAccess`, `filterAccessible`, `assertNamespaceAccess`, `assertStorageScope` (same signatures as today)
  - `type { ProjectRole }` re-export
- **Removed:** `createProject`, `updateProjectMembers`, `ensureDefaultProject`, `projectInputSchema`. (Callers are fixed in Tasks 6–7; typecheck will be red until then — that is expected and listed in Step 6.)

- [ ] **Step 1: Test helpers**

```ts
// src/server/auth/session.test-helpers.ts
import type { Role } from './rbac';
import type { Session } from './session';
import type { Project } from './projects';
import { projectItem } from './projects';
import type { KV } from '../store/dynamo';

const platformGroup: Record<Role, string> = { admin: 'admins', researcher: 'researchers', viewer: 'viewers' };
/** Session literal with the platform group implied by `role` plus any project groups. */
export function testSession(user: string, subject: string, role: Role, groups: string[] = []): Session {
  return { user, subject, email: `${user}@example.test`, role, groups: [platformGroup[role], ...groups] };
}
export const testClusterArn = 'arn:aws:sagemaker:us-east-1:123456789012:cluster/test-cluster';
export function projectFixture(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, computeQuotaId: `quota-${id}`, clusterArn: testClusterArn, namespace: `hyperpod-ns-${id}`, queue: `hyperpod-ns-${id}-localqueue`,
    credentialRefs: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra };
}
export async function putProject(kv: KV, id: string, extra: Partial<Project> = {}): Promise<Project> {
  const project = projectFixture(id, extra);
  await kv.put(projectItem(project));
  return project;
}
```

- [ ] **Step 2: Write the failing tests**

Replace `src/server/auth/projects.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import {
  assertNamespaceAccess, assertStorageScope, canReadResource, filterAccessible, listProjects, memberRole, namespaceOf,
  projectFromItem, projectIdFromNamespace, projectItem, queueOf, resolveProject, updateProjectMeta,
} from './projects';
import { projectFixture, putProject, testSession } from './session.test-helpers';

const admin = testSession('admin', 'admin-sub', 'admin');
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a']);
const lead = testSession('lead', 'lead-sub', 'viewer', ['proj-team-a-admin']);
const bob = testSession('bob', 'bob-sub', 'researcher');
let repo: Repo;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  await putProject(repo.kv, 'team-a');
  await putProject(repo.kv, 'team-b', { backendId: 'gpu-2' });
});

describe('derived namespace and queue', () => {
  it('derives from the id and never persists them', () => {
    const p = projectFixture('team-a');
    expect(namespaceOf(p)).toBe('hyperpod-ns-team-a');
    expect(queueOf(p)).toBe('hyperpod-ns-team-a-localqueue');
    const item = projectItem(p);
    expect(item).not.toHaveProperty('namespace');
    expect(item).not.toHaveProperty('queue');
    expect(item).toMatchObject({ pk: 'PROJECT#team-a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'team-a' });
    // Stale persisted values from the old schema are ignored on read.
    expect(projectFromItem({ ...item, namespace: 'hyperpod-ns-wrong', queue: 'q', members: { x: 'viewer' } })).toMatchObject({ namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue' });
    expect(projectFromItem(item)).not.toHaveProperty('members');
    expect(projectIdFromNamespace('hyperpod-ns-team-a')).toBe('team-a');
    expect(projectIdFromNamespace('kube-system')).toBeUndefined();
  });
});

describe('memberRole', () => {
  it('reads the session groups and lets platform admins through', () => {
    expect(memberRole(alice, { id: 'team-a' })).toBe('researcher');
    expect(memberRole(lead, { id: 'team-a' })).toBe('project-admin');
    expect(memberRole(bob, { id: 'team-a' })).toBeUndefined();
    expect(memberRole(admin, { id: 'team-a' })).toBe('project-admin');
  });
  it('confines API tokens to their bound project', () => {
    const token = { ...alice, authMethod: 'token' as const, tokenProjectId: 'team-b' };
    expect(memberRole(token, { id: 'team-a' })).toBeUndefined();
    expect(memberRole({ ...admin, tokenProjectId: 'team-b' }, { id: 'team-a' })).toBeUndefined();
  });
});

describe('project authorization', () => {
  it('lists and resolves by membership without any Cognito call', async () => {
    expect((await listProjects(alice, repo)).map((p) => p.id)).toEqual(['team-a']);
    expect((await listProjects(admin, repo)).map((p) => p.id)).toEqual(['team-a', 'team-b']);
    expect(await listProjects(bob, repo)).toEqual([]);
    expect((await resolveProject(alice, 'team-a', repo)).namespace).toBe('hyperpod-ns-team-a');
    expect((await resolveProject(alice, undefined, repo)).id).toBe('team-a');
    await expect(resolveProject(bob, 'team-a', repo)).rejects.toThrow(/project/);
    await expect(resolveProject(bob, undefined, repo)).rejects.toThrow(/project/);
    await expect(resolveProject(alice, 'team-a', repo, 'project-admin')).rejects.toThrow(/project-admin/);
    expect((await resolveProject(lead, 'team-a', repo, 'project-admin')).id).toBe('team-a');
  });
  it('checks resources from the session alone (no kv read)', async () => {
    const spy = vi.spyOn(repo.kv, 'get');
    expect(await canReadResource(alice, { projectId: 'team-a', owner: 'other' }, repo)).toBe(true);
    expect(await canReadResource(bob, { projectId: 'team-a', owner: 'bob' }, repo)).toBe(false);
    expect(await canReadResource({ ...alice, tokenProjectId: 'team-b' }, { projectId: 'team-a' }, repo)).toBe(false);
    const rows = [{ projectId: 'team-a' }, { projectId: 'team-b' }, { owner: 'alice' }, { owner: 'bob' }];
    expect(await filterAccessible(alice, rows)).toEqual([{ projectId: 'team-a' }, { owner: 'alice' }]);
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps legacy records visible to their owner or platform admin', async () => {
    expect(await canReadResource(alice, { owner: 'alice' }, repo)).toBe(true);
    expect(await canReadResource(bob, { owner: 'alice' }, repo)).toBe(false);
    expect(await canReadResource(admin, { owner: 'alice' }, repo)).toBe(true);
  });
  it('maps a namespace back to a project for namespace access', async () => {
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-team-a', false, 'default', repo)).resolves.toBeUndefined();
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-team-a', false, 'gpu-2', repo)).rejects.toThrow(/namespace/);
    await expect(assertNamespaceAccess(bob, 'hyperpod-ns-team-a', false, 'default', repo)).rejects.toThrow(/namespace/);
    await expect(assertNamespaceAccess(lead, 'hyperpod-ns-team-a', true, 'default', repo)).resolves.toBeUndefined();
    await expect(assertNamespaceAccess(testSession('v', 'v-sub', 'viewer', ['proj-team-a']), 'hyperpod-ns-team-a', true, 'default', repo)).rejects.toThrow(/read-only/);
    await expect(assertNamespaceAccess(alice, 'kube-system', false, 'default', repo)).rejects.toThrow(/System/);
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-ghost', false, 'default', repo)).rejects.toThrow(/namespace/);
  });
  it('lets project admins edit metadata only', async () => {
    const updated = await updateProjectMeta(lead, 'team-a', { name: 'Team A', description: 'robots' }, repo);
    expect(updated).toMatchObject({ name: 'Team A', description: 'robots', namespace: 'hyperpod-ns-team-a' });
    expect(await repo.kv.get('PROJECT#team-a', 'META')).not.toHaveProperty('namespace');
    await expect(updateProjectMeta(alice, 'team-a', { name: 'x' }, repo)).rejects.toThrow(/project-admin/);
    await expect(updateProjectMeta(lead, 'team-a', { id: 'other' } as never, repo)).rejects.toThrow();
  });
  it('allows only the project prefixes for ordinary storage access', () => {
    const project = projectFixture('team-a');
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/v1/data.parquet')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'checkpoints/projects/team-a/runs/abc/model.pt')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-ab/v1/data.parquet')).toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/../team-b/data')).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/server/auth/projects.test.ts`
Expected: FAIL — missing exports (`memberRole`, `projectItem`, …).

- [ ] **Step 4: Rewrite `projects.ts`**

```ts
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import type { Session } from './session';
import { PROJECT_ROLE_RANK, projectRoleFromGroups, type ProjectRole } from './rbac';
import { backendId, DEFAULT_BACKEND } from '../backends/registry';
import { currentBackend } from '../backends/context';

export type { ProjectRole } from './rbac';
export const projectIdPattern = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A project is a thin adoption of a HyperPod task-governance Team (ComputeQuota). `id` is the TeamName;
 * `namespace`/`queue` are derived on read and never persisted; membership lives in Cognito groups.
 */
export interface Project {
  id: string;
  name: string;
  computeQuotaId: string;
  clusterArn: string;
  /** Missing on legacy projects means only the original default EKS backend. */
  backendId?: string;
  backendConfigHash?: string;
  namespace: string;
  queue: string;
  credentialRefs: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}
export const namespaceOf = (p: Pick<Project, 'id'>) => `hyperpod-ns-${p.id}`;
export const queueOf = (p: Pick<Project, 'id'>) => `${namespaceOf(p)}-localqueue`;
export const projectIdFromNamespace = (namespace: string) => /^hyperpod-ns-([a-z][a-z0-9-]{0,39})$/.exec(namespace)?.[1];

export function projectFromItem(item: Record<string, unknown>): Project {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, namespace: _ns, queue: _q, members: _m, ...stored } = item;
  const base = stored as unknown as Omit<Project, 'namespace' | 'queue'>;
  return { ...base, namespace: namespaceOf(base), queue: queueOf(base) };
}
export function projectItem(project: Project): Item {
  const { namespace: _ns, queue: _q, ...stored } = project;
  return { pk: `PROJECT#${project.id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: project.id, ...stored };
}

const principal = (session: Session) => session.subject ?? session.user;

/** The caller's role in a project. Platform admins act as project-admin; API tokens only see their bound project. */
export function memberRole(session: Session, project: Pick<Project, 'id'>): ProjectRole | undefined {
  if (session.tokenProjectId && session.tokenProjectId !== project.id) return undefined;
  if (session.role === 'admin') return 'project-admin';
  return projectRoleFromGroups(session.groups, project.id);
}
export const isMember = (session: Session, project: Pick<Project, 'id'>) => memberRole(session, project) !== undefined;
export const canWriteIn = (session: Session, project: Pick<Project, 'id'>) => { const role = memberRole(session, project); return role !== undefined && role !== 'viewer'; };
export const isProjectAdmin = (session: Session, project: Pick<Project, 'id'>) => memberRole(session, project) === 'project-admin';

export async function getProject(id: string, repo: Repo = getRepo()): Promise<Project | undefined> {
  if (!projectIdPattern.test(id)) return undefined;
  const item = await repo.kv.get(`PROJECT#${id}`, 'META');
  return item ? projectFromItem(item) : undefined;
}
export async function listAllProjects(repo: Repo = getRepo()): Promise<Project[]> {
  const indexed = await repo.kv.queryGsi1('TYPE#PROJECT');
  // GSIs discover projects, but authorization always uses the strongly consistent META.
  const records = await Promise.all(indexed.map((item) => repo.kv.get(item.pk, 'META')));
  return records.filter((item) => item !== undefined).map(projectFromItem).sort((a, b) => a.id.localeCompare(b.id));
}
export async function listProjects(session: Session, repo: Repo = getRepo()): Promise<Project[]> {
  return (await listAllProjects(repo)).filter((project) => isMember(session, project));
}

export async function resolveProject(session: Session, id?: string, repo: Repo = getRepo(), required: ProjectRole = 'viewer'): Promise<Project> {
  if (session.tokenProjectId && id && id !== session.tokenProjectId) throw forbidden('Token is bound to another project');
  const project = id ? await getProject(id, repo) : (await listProjects(session, repo))[0];
  const role = project ? memberRole(session, project) : undefined;
  if (!project || !role) throw forbidden('No access to the requested project. Ask a project administrator to add you to its Cognito group.');
  if (PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK[required]) throw forbidden(`This project requires ${required} permission`);
  return project;
}

export async function requestProject(req: Request, session: Session, required: ProjectRole = 'viewer') {
  if (session.tokenProjectId) return resolveProject(session, session.tokenProjectId, getRepo(), required);
  const cookie = /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  let id = req.headers.get('x-pai-project') ?? undefined;
  if (!id && cookie) {
    try { id = decodeURIComponent(cookie); } catch { throw badRequest('Invalid project cookie'); }
  }
  return resolveProject(session, id, getRepo(), required);
}

export const projectMetaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  credentialRefs: z.array(z.string().startsWith('/')).max(30).optional(),
}).strict();
export async function updateProjectMeta(session: Session, id: string, input: unknown, repo: Repo = getRepo()): Promise<Project> {
  const project = await resolveProject(session, id, repo, 'project-admin');
  const parsed = projectMetaSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid project metadata', { issues: parsed.error.issues });
  const updated: Project = { ...project, ...parsed.data, updatedAt: new Date().toISOString() };
  await repo.kv.put(projectItem(updated));
  return updated;
}

export interface OwnedResource { owner?: string; ownerSubject?: string; projectId?: string }
export async function canReadResource(session: Session, resource: OwnedResource, _repo: Repo = getRepo()): Promise<boolean> {
  if (session.tokenProjectId && resource.projectId !== session.tokenProjectId) return false;
  if (session.role === 'admin') return true;
  if (resource.projectId) return isMember(session, { id: resource.projectId });
  return resource.ownerSubject ? resource.ownerSubject === principal(session) : resource.owner === session.user;
}
export async function assertResourceAccess(session: Session, resource: OwnedResource | undefined, what = 'resource', write = false) {
  if (!resource || !(await canReadResource(session, resource))) throw notFound(what);
  if (write && resource.projectId) await resolveProject(session, resource.projectId, getRepo(), 'researcher');
}
export async function filterAccessible<T extends OwnedResource>(session: Session, resources: T[]): Promise<T[]> {
  const results = await Promise.all(resources.map((resource) => canReadResource(session, resource)));
  return resources.filter((_, index) => results[index]);
}
export async function assertNamespaceAccess(session: Session, namespace: string, write = false, selectedBackend = currentBackend()?.id ?? DEFAULT_BACKEND, repo: Repo = getRepo()) {
  if (/^(kube-|aws-|hyperpod-observability$|grafana$|kubeflow$|mpi-operator$)/.test(namespace)) {
    throw forbidden('System namespaces are not a researcher workspace');
  }
  if (session.role === 'admin') return;
  const id = projectIdFromNamespace(namespace);
  const role = id ? memberRole(session, { id }) : undefined;
  const project = id && role ? await getProject(id, repo) : undefined;
  if (!project || backendId(project.backendId) !== selectedBackend) throw forbidden('No access to this project namespace');
  if (write && role === 'viewer') throw forbidden('Project is read-only');
}
export function assertStorageScope(session: Session, project: Project, key: string) {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) throw forbidden('Invalid storage path');
  if (session.role === 'admin') return;
  const prefixes = [`projects/${project.id}/`, `datasets/projects/${project.id}/`, `checkpoints/projects/${project.id}/`];
  if (!prefixes.some((prefix) => key.startsWith(prefix))) throw forbidden('Storage path belongs to another project');
}
```

- [ ] **Step 5: Run the projects tests**

Run: `npx vitest run src/server/auth/projects.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Record the expected typecheck breakage**

Run: `npm run typecheck 2>&1 | grep -c "error TS"`
Expected: a non-zero count — callers of `createProject`, `updateProjectMembers`, `ensureDefaultProject`, `projectInputSchema`, and readers of `.members`. Do **not** fix them here; Tasks 6–8 do. Paste the list of failing files into the commit body so the next tasks have it.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth/projects.ts src/server/auth/projects.test.ts src/server/auth/session.test-helpers.ts
git commit -m "refactor(dashboard): project = adopted ComputeQuota; membership via memberRole from session groups

namespace/queue are derived on read from id; members map removed. Callers of the
removed createProject/updateProjectMembers/ensureDefaultProject and .members readers
are migrated in the following commits (typecheck intentionally red here).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Adoption, deletion, attachment (`project-adoption.ts`) and members (`project-members.ts`)

**Files:**
- Create: `src/server/auth/project-adoption.ts`
- Create: `src/server/auth/project-members.ts`
- Test: `src/server/auth/project-adoption.test.ts`, `src/server/auth/project-members.test.ts`

**Interfaces:**
- Consumes: `projectItem`, `projectFromItem`, `namespaceOf`, `queueOf`, `projectIdPattern`, `resolveProject`, `getProject`, `listAllProjects` (Task 4); `createProjectGroups`/`deleteProjectGroups`/`setProjectGroups`/`listUsers`/`ProjectMembership` (Task 3); `describeComputeQuota`, `listComputeQuotas`, `describeCluster` (hyperpod.ts).
- Produces:
  - `adoptInputSchema` (zod), `interface AdoptionDeps`, `productionAdoptionDeps(): AdoptionDeps`
  - `adoptProject(session, input, deps): Promise<Project>`
  - `deleteProject(session, id, deps): Promise<void>`
  - `type Attachment = 'ATTACHED' | 'DETACHED' | 'UNKNOWN'`, `attachmentsFor(projects, deps): Promise<Map<string, Attachment>>`, `resetAttachmentCacheForTests()`
  - `listProjectMembers(session, id, deps): Promise<ProjectMember[]>`, `setProjectMembership(session, id, username, role, deps): Promise<void>`, `interface ProjectMember { username; subject?; email?; role: ProjectRole }`

- [ ] **Step 1: Write the failing adoption tests**

```ts
// src/server/auth/project-adoption.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { adoptProject, attachmentsFor, deleteProject, resetAttachmentCacheForTests, type AdoptionDeps } from './project-adoption';
import { getProject } from './projects';
import { projectFixture, putProject, testClusterArn, testSession } from './session.test-helpers';

const admin = testSession('admin', 'admin-sub', 'admin');
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a-admin']);
let repo: Repo, deps: AdoptionDeps, quotas: Array<{ id: string; teamName?: string; clusterArn?: string; status?: string }>;
beforeEach(() => {
  repo = new Repo(new MemoryKV());
  resetAttachmentCacheForTests();
  quotas = [{ id: 'q-team-a', teamName: 'team-a', clusterArn: testClusterArn, status: 'Created' }, { id: 'q-9lives', teamName: '9lives', clusterArn: testClusterArn }];
  deps = {
    repo, now: () => new Date('2026-09-20T00:00:00Z'),
    describeComputeQuota: vi.fn(async (id: string) => { const q = quotas.find((x) => x.id === id); if (!q) throw Object.assign(new Error('nf'), { name: 'ResourceNotFound' }); return q; }),
    currentClusterArn: vi.fn(async () => testClusterArn),
    localQueueExists: vi.fn(async (namespace: string, name: string) => namespace === 'hyperpod-ns-team-a' && name === 'hyperpod-ns-team-a-localqueue'),
    createProjectGroups: vi.fn(async () => undefined),
    deleteProjectGroups: vi.fn(async () => undefined),
    listComputeQuotas: vi.fn(async () => quotas.map((q) => ({ id: q.id, teamName: q.teamName }))),
  };
});

describe('adoptProject', () => {
  it('adopts a ComputeQuota as a project keyed by TeamName and reserves namespace + quota', async () => {
    const project = await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    expect(project).toMatchObject({ id: 'team-a', name: 'team-a', computeQuotaId: 'q-team-a', clusterArn: testClusterArn, namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue', credentialRefs: [] });
    expect(project.backendId).toBe('default');
    expect(deps.createProjectGroups).toHaveBeenCalledWith('team-a');
    expect(await repo.kv.get('PROJECT#team-a', 'META')).not.toHaveProperty('namespace');
    expect(await repo.kv.get('PROJECT_NAMESPACE#default#hyperpod-ns-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
    expect(await repo.kv.get('PROJECT_NAMESPACE#hyperpod-ns-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
    expect(await repo.kv.get('PROJECT_QUOTA#q-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
  });
  it('honours an explicit name/description and requires platform admin', async () => {
    expect((await adoptProject(admin, { computeQuotaId: 'q-team-a', name: 'Team A', description: 'arms' }, deps))).toMatchObject({ name: 'Team A', description: 'arms' });
    await expect(adoptProject(alice, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/admin/);
  });
  it('rejects team names outside the project id rule, foreign clusters, missing queues and unknown quotas', async () => {
    await expect(adoptProject(admin, { computeQuotaId: 'q-9lives' }, deps)).rejects.toThrow(/식별자 규칙/);
    quotas[0].clusterArn = 'arn:aws:sagemaker:us-east-1:123456789012:cluster/other';
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/cluster/i);
    quotas[0].clusterArn = testClusterArn; quotas[0].teamName = 'team-c';
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/큐/);
    await expect(adoptProject(admin, { computeQuotaId: 'nope' }, deps)).rejects.toThrow(/ComputeQuota/);
  });
  it('refuses to adopt the same quota or team twice', async () => {
    await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/이미 채택/);
    quotas.push({ id: 'q-dup', teamName: 'team-a', clusterArn: testClusterArn });
    await expect(adoptProject(admin, { computeQuotaId: 'q-dup' }, deps)).rejects.toThrow(/이미 채택/);
  });
});

describe('deleteProject', () => {
  it('removes the adoption record, reservations and groups but nothing else', async () => {
    await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    await repo.kv.put({ pk: 'WF#run-1', sk: 'META', projectId: 'team-a' });
    await deleteProject(admin, 'team-a', deps);
    expect(await getProject('team-a', repo)).toBeUndefined();
    expect(await repo.kv.get('PROJECT_NAMESPACE#default#hyperpod-ns-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('PROJECT_NAMESPACE#hyperpod-ns-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('PROJECT_QUOTA#q-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('WF#run-1', 'META')).toBeDefined();
    expect(deps.deleteProjectGroups).toHaveBeenCalledWith('team-a');
    await expect(deleteProject(alice, 'team-a', deps)).rejects.toThrow(/admin/);
    await expect(deleteProject(admin, 'team-a', deps)).rejects.toThrow(/not found/i);
  });
});

describe('attachmentsFor', () => {
  it('reports ATTACHED / DETACHED / UNKNOWN and caches per cluster for 60s', async () => {
    const a = await putProject(repo.kv, 'team-a', { computeQuotaId: 'q-team-a' });
    const b = await putProject(repo.kv, 'team-b', { computeQuotaId: 'q-gone' });
    const c = projectFixture('team-c', { computeQuotaId: 'q-team-a', clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/broken' });
    (deps.listComputeQuotas as ReturnType<typeof vi.fn>).mockImplementation(async (arn: string) => { if (arn.endsWith('broken')) throw new Error('boom'); return quotas.map((q) => ({ id: q.id, teamName: q.teamName })); });
    const first = await attachmentsFor([a, b, c], deps);
    expect(first.get('team-a')).toBe('ATTACHED');
    expect(first.get('team-b')).toBe('DETACHED');
    expect(first.get('team-c')).toBe('UNKNOWN');
    await attachmentsFor([a, b], deps);
    expect(deps.listComputeQuotas).toHaveBeenCalledTimes(2); // one per distinct cluster; second call served from cache
    quotas[0].teamName = 'renamed';
    resetAttachmentCacheForTests();
    expect((await attachmentsFor([a], deps)).get('team-a')).toBe('DETACHED');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/auth/project-adoption.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `project-adoption.ts`**

```ts
import { z } from 'zod';
import { badRequest, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import { requireRole, type Session } from './session';
import { DEFAULT_BACKEND, backendId, resolveBackend } from '../backends/registry';
import { backendConfig, currentBackend } from '../backends/context';
import { listLocalQueues } from '../k8s/kueue';
import * as hp from '../aws/hyperpod';
import * as cognito from '../aws/cognito';
import { namespaceOf, projectIdPattern, projectItem, queueOf, getProject, listAllProjects, type Project } from './projects';

export const adoptInputSchema = z.object({
  computeQuotaId: z.string().min(1).max(128),
  backendId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default(DEFAULT_BACKEND),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  credentialRefs: z.array(z.string().startsWith('/')).max(30).default([]),
}).strict();
export type AdoptInput = z.input<typeof adoptInputSchema>;

export interface QuotaSummary { id: string; teamName?: string; clusterArn?: string; status?: string }
export interface AdoptionDeps {
  repo: Repo;
  now(): Date;
  describeComputeQuota(id: string): Promise<QuotaSummary>;
  /** HyperPod cluster ARN of the backend the request runs on (runOnBackend context). */
  currentClusterArn(): Promise<string>;
  localQueueExists(namespace: string, name: string): Promise<boolean>;
  createProjectGroups(projectId: string): Promise<void>;
  deleteProjectGroups(projectId: string): Promise<void>;
  listComputeQuotas(clusterArn: string): Promise<Array<{ id: string; teamName?: string }>>;
}
export function productionAdoptionDeps(): AdoptionDeps {
  return {
    repo: getRepo(), now: () => new Date(),
    async describeComputeQuota(id) {
      const d = await hp.describeComputeQuota(id);
      return { id, teamName: d.ComputeQuotaTarget?.TeamName, clusterArn: d.ClusterArn, status: d.Status };
    },
    async currentClusterArn() {
      const name = backendConfig().eks?.hyperPodClusterName;
      if (!name) throw badRequest('HyperPod EKS cluster is not configured for this backend');
      const arn = (await hp.describeCluster(name)).ClusterArn;
      if (!arn) throw badRequest('HyperPod cluster ARN is unavailable');
      return arn;
    },
    async localQueueExists(namespace, name) {
      return (await listLocalQueues()).some((q) => q.metadata.namespace === namespace && q.metadata.name === name);
    },
    createProjectGroups: cognito.createProjectGroups,
    deleteProjectGroups: cognito.deleteProjectGroups,
    async listComputeQuotas(clusterArn) {
      return (await hp.listComputeQuotas(clusterArn)).map((q) => ({ id: q.ComputeQuotaId!, teamName: q.ComputeQuotaTarget?.TeamName }));
    },
  };
}

const namespaceOwnerKeys = (backend: string, namespace: string) => [
  { pk: `PROJECT_NAMESPACE#${backend}#${namespace}`, sk: 'OWNER' },
  ...(backend === DEFAULT_BACKEND ? [{ pk: `PROJECT_NAMESPACE#${namespace}`, sk: 'OWNER' }] : []),
];
const quotaOwnerKey = (computeQuotaId: string) => ({ pk: `PROJECT_QUOTA#${computeQuotaId}`, sk: 'OWNER' });

/** Adopt a task-governance Team (ComputeQuota) as a project. Platform admin only; runs inside runOnBackend(input). */
export async function adoptProject(session: Session, raw: AdoptInput, deps: AdoptionDeps = productionAdoptionDeps()): Promise<Project> {
  requireRole(session, 'admin');
  const parsed = adoptInputSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid adoption request', { issues: parsed.error.issues });
  const input = parsed.data;
  let quota: QuotaSummary;
  try { quota = await deps.describeComputeQuota(input.computeQuotaId); }
  catch { throw badRequest('ComputeQuota를 찾을 수 없습니다. HyperPod 콘솔에서 팀(컴퓨트 할당)을 먼저 만드세요.'); }
  const id = quota.teamName ?? '';
  if (!projectIdPattern.test(id)) throw badRequest(`팀 이름 '${id}'이(가) 프로젝트 식별자 규칙(${projectIdPattern.source})에 맞지 않습니다.`);
  const clusterArn = await deps.currentClusterArn();
  if (quota.clusterArn !== clusterArn) throw badRequest('ComputeQuota belongs to a different HyperPod cluster than the selected backend');
  const namespace = namespaceOf({ id }), queue = queueOf({ id });
  if (input.backendId !== DEFAULT_BACKEND) {
    const backend = await resolveBackend({ backendId: input.backendId }, deps.repo, deps.now);
    if (!backend.profile.namespaces.includes(namespace)) throw badRequest('namespace is not allowed on this backend');
  }
  if (!(await deps.localQueueExists(namespace, queue))) throw badRequest('실행 가능한 큐가 아직 없습니다. 팀 네임스페이스와 LocalQueue가 준비된 뒤 다시 시도하세요.');
  const existing = await listAllProjects(deps.repo);
  if (existing.some((p) => p.id === id || p.computeQuotaId === input.computeQuotaId)) throw badRequest('이미 채택된 팀 또는 ComputeQuota입니다.');
  await deps.createProjectGroups(id);
  const now = deps.now().toISOString();
  const project: Project = {
    id, name: input.name ?? id, computeQuotaId: input.computeQuotaId, clusterArn, backendId: input.backendId,
    ...(currentBackend()?.configurationHash ? { backendConfigHash: currentBackend()!.configurationHash } : {}),
    namespace, queue, credentialRefs: input.credentialRefs, ...(input.description ? { description: input.description } : {}),
    createdAt: now, updatedAt: now,
  };
  const ok = await deps.repo.kv.transaction([
    { kind: 'put', item: projectItem(project), condition: { absent: true } },
    ...namespaceOwnerKeys(input.backendId, namespace).map((key) => ({ kind: 'put' as const, item: { ...key, projectId: id, backendId: input.backendId }, condition: { absent: true as const } })),
    { kind: 'put', item: { ...quotaOwnerKey(input.computeQuotaId), projectId: id }, condition: { absent: true } },
  ]);
  if (!ok) throw badRequest('이미 채택된 팀 또는 ComputeQuota입니다.');
  return project;
}

/** Remove the adoption record and groups. ComputeQuota, workflows, datasets and storage are left untouched. */
export async function deleteProject(session: Session, id: string, deps: AdoptionDeps = productionAdoptionDeps()): Promise<void> {
  requireRole(session, 'admin');
  const project = await getProject(id, deps.repo);
  if (!project) throw notFound('project');
  const backend = backendId(project.backendId);
  await deps.repo.kv.transaction([
    { kind: 'delete', pk: `PROJECT#${id}`, sk: 'META' },
    ...namespaceOwnerKeys(backend, project.namespace).map((key) => ({ kind: 'delete' as const, ...key })),
    { kind: 'delete', ...quotaOwnerKey(project.computeQuotaId) },
  ]);
  await deps.deleteProjectGroups(id);
}

export type Attachment = 'ATTACHED' | 'DETACHED' | 'UNKNOWN';
const ATTACHMENT_TTL_MS = 60_000;
const quotaCache = new Map<string, { at: number; quotas?: Array<{ id: string; teamName?: string }> }>();
export function resetAttachmentCacheForTests() { quotaCache.clear(); }
async function clusterQuotas(clusterArn: string, deps: AdoptionDeps) {
  const cached = quotaCache.get(clusterArn);
  const now = deps.now().getTime();
  if (cached && now - cached.at < ATTACHMENT_TTL_MS) return cached.quotas;
  let quotas: Array<{ id: string; teamName?: string }> | undefined;
  try { quotas = await deps.listComputeQuotas(clusterArn); } catch { quotas = undefined; }
  quotaCache.set(clusterArn, { at: now, quotas });
  return quotas;
}
/** Never called on the authorization hot path; list/detail routes only. */
export async function attachmentsFor(projects: Project[], deps: AdoptionDeps = productionAdoptionDeps()): Promise<Map<string, Attachment>> {
  const result = new Map<string, Attachment>();
  const byCluster = new Map<string, Project[]>();
  for (const p of projects) byCluster.set(p.clusterArn, [...(byCluster.get(p.clusterArn) ?? []), p]);
  for (const [clusterArn, group] of byCluster) {
    const quotas = await clusterQuotas(clusterArn, deps);
    for (const p of group) {
      result.set(p.id, quotas === undefined ? 'UNKNOWN' : quotas.some((q) => q.id === p.computeQuotaId && q.teamName === p.id) ? 'ATTACHED' : 'DETACHED');
    }
  }
  return result;
}
```

Note on `transaction` deletes: `Write` already supports `{ kind: 'delete', pk, sk, condition? }` (used in `pipeline-archives.ts`). If `MemoryKV` rejects a delete without a condition, pass `condition: { absent: false }`-style is **not** available — instead check `src/server/store/dynamo.ts` `Write` type and follow it exactly.

- [ ] **Step 4: Run adoption tests**

Run: `npx vitest run src/server/auth/project-adoption.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing members tests**

```ts
// src/server/auth/project-members.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { listProjectMembers, setProjectMembership, type MembersDeps } from './project-members';
import { putProject, testSession } from './session.test-helpers';

const lead = testSession('lead', 'lead-sub', 'viewer', ['proj-team-a-admin']);
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a']);
let repo: Repo, deps: MembersDeps;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  await putProject(repo.kv, 'team-a');
  deps = { repo,
    listUsers: vi.fn(async () => [
      { username: 'alice', subject: 'alice-sub', email: 'a@x', groups: ['researchers', 'proj-team-a'] },
      { username: 'lead', subject: 'lead-sub', email: 'l@x', groups: ['viewers', 'proj-team-a-admin'] },
      { username: 'bob', subject: 'bob-sub', email: 'b@x', groups: ['researchers', 'proj-team-b'] },
    ]),
    setProjectGroups: vi.fn(async () => undefined) };
});
describe('project members via Cognito groups', () => {
  it('lists only members of this project with their composed role', async () => {
    expect(await listProjectMembers(lead, 'team-a', deps)).toEqual([
      { username: 'alice', subject: 'alice-sub', email: 'a@x', role: 'researcher' },
      { username: 'lead', subject: 'lead-sub', email: 'l@x', role: 'project-admin' },
    ]);
    await expect(listProjectMembers(alice, 'team-a', deps)).rejects.toThrow(/project-admin/);
  });
  it('changes only this project\'s groups and validates the username', async () => {
    await setProjectMembership(lead, 'team-a', 'bob', 'member', deps);
    expect(deps.setProjectGroups).toHaveBeenCalledWith('bob', 'team-a', 'member');
    await setProjectMembership(lead, 'team-a', 'alice', null, deps);
    expect(deps.setProjectGroups).toHaveBeenCalledWith('alice', 'team-a', null);
    await expect(setProjectMembership(lead, 'team-a', 'bad user!', 'member', deps)).rejects.toThrow(/username/i);
    await expect(setProjectMembership(alice, 'team-a', 'bob', 'member', deps)).rejects.toThrow(/project-admin/);
  });
});
```

- [ ] **Step 6: Implement `project-members.ts`**

```ts
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
  await deps.setProjectGroups(username, id, role);
}
```

- [ ] **Step 7: Run both test files**

Run: `npx vitest run src/server/auth/project-adoption.test.ts src/server/auth/project-members.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/auth/project-adoption.ts src/server/auth/project-adoption.test.ts src/server/auth/project-members.ts src/server/auth/project-members.test.ts
git commit -m "feat(dashboard): adopt/delete ComputeQuota-backed projects; members via Cognito groups; attachment status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Project API routes

**Files:**
- Rewrite: `src/app/api/projects/route.ts`
- Rewrite: `src/app/api/projects/[id]/route.ts`
- Create: `src/app/api/projects/[id]/members/route.ts`
- Create: `src/app/api/projects/[id]/members/[username]/route.ts`
- Test: `src/app/api/projects/routes.test.ts` (create)

**Interfaces:**
- Consumes: Task 4 & 5 exports.
- Produces (HTTP):
  - `GET /api/projects` → `ProjectView[]` where `ProjectView = Project & { myRole?: ProjectRole; attachment: Attachment }`
  - `POST /api/projects` (admin) body `AdoptInput` → `ProjectView`
  - `GET /api/projects/[id]` → `ProjectView`; `PATCH` (researcher; project-admin enforced inside) body `projectMetaSchema` → `ProjectView`; `DELETE` (admin) → `{ ok: true }`
  - `GET /api/projects/[id]/members` (researcher) → `{ members: ProjectMember[] }`
  - `PUT /api/projects/[id]/members/[username]` (researcher) body `{ role: 'member' | 'project-admin' | null }` → `{ ok: true }`
- Also export `ProjectView` type from `src/server/auth/project-adoption.ts`? No — define it in a tiny shared module `src/server/auth/project-view.ts` so UI code can import the type without pulling server code:

```ts
// src/server/auth/project-view.ts
import type { Project, ProjectRole } from './projects';
import type { Attachment } from './project-adoption';
export interface ProjectView extends Project { myRole?: ProjectRole; attachment: Attachment }
```

- [ ] **Step 1: Write the failing route test**

```ts
// src/app/api/projects/routes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  describeComputeQuota: vi.fn(), describeCluster: vi.fn(), listComputeQuotas: vi.fn(), listLocalQueues: vi.fn(),
  createProjectGroups: vi.fn(), deleteProjectGroups: vi.fn(), listUsers: vi.fn(), setProjectGroups: vi.fn(),
}));
vi.mock('@/server/aws/hyperpod', async (original) => ({ ...await original<typeof import('@/server/aws/hyperpod')>(),
  describeComputeQuota: mocks.describeComputeQuota, describeCluster: mocks.describeCluster, listComputeQuotas: mocks.listComputeQuotas }));
vi.mock('@/server/k8s/kueue', async (original) => ({ ...await original<typeof import('@/server/k8s/kueue')>(), listLocalQueues: mocks.listLocalQueues }));
vi.mock('@/server/aws/cognito', async (original) => ({ ...await original<typeof import('@/server/aws/cognito')>(),
  createProjectGroups: mocks.createProjectGroups, deleteProjectGroups: mocks.deleteProjectGroups, listUsers: mocks.listUsers, setProjectGroups: mocks.setProjectGroups }));

import { resetConfigForTests } from '@/server/config';
import { MemoryKV } from '@/server/store/dynamo';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { resetAttachmentCacheForTests } from '@/server/auth/project-adoption';
import { SESSION_HEADERS } from '@/server/auth/session';
import { GET as list, POST as adopt } from './route';
import { DELETE as remove, GET as detail, PATCH as patch } from './[id]/route';
import { GET as members } from './[id]/members/route';
import { PUT as setMember } from './[id]/members/[username]/route';

const origin = 'https://projects.example';
const arn = 'arn:aws:sagemaker:us-east-1:123456789012:cluster/hp';
function request(path: string, opts: { method?: string; role?: string; groups?: string[]; body?: unknown } = {}) {
  return new NextRequest(origin + path, { method: opts.method ?? 'GET', headers: {
    [SESSION_HEADERS.user]: 'u', [SESSION_HEADERS.subject]: 'u-sub', [SESSION_HEADERS.role]: opts.role ?? 'admin',
    [SESSION_HEADERS.groups]: (opts.groups ?? [opts.role === 'researcher' ? 'researchers' : opts.role === 'viewer' ? 'viewers' : 'admins']).join(','),
    [SESSION_HEADERS.authMethod]: 'alb', origin, 'content-type': 'application/json',
  }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks(); resetAttachmentCacheForTests();
  vi.stubEnv('AUTH_MODE', 'dev'); vi.stubEnv('DASHBOARD_ORIGIN', origin);
  vi.stubEnv('EKS_CLUSTER_NAME', 'eks'); vi.stubEnv('HYPERPOD_CLUSTER_NAME', 'hp');
  resetConfigForTests();
  setRepoForTests(new Repo(new MemoryKV()));
  mocks.describeComputeQuota.mockResolvedValue({ ComputeQuotaId: 'q1', ComputeQuotaTarget: { TeamName: 'team-a' }, ClusterArn: arn, Status: 'Created' });
  mocks.describeCluster.mockResolvedValue({ ClusterArn: arn });
  mocks.listComputeQuotas.mockResolvedValue([{ ComputeQuotaId: 'q1', ComputeQuotaTarget: { TeamName: 'team-a' } }]);
  mocks.listLocalQueues.mockResolvedValue([{ metadata: { name: 'hyperpod-ns-team-a-localqueue', namespace: 'hyperpod-ns-team-a' }, spec: { clusterQueue: 'cq' } }]);
  mocks.listUsers.mockResolvedValue([{ username: 'alice', subject: 'a-sub', email: 'a@x', groups: ['researchers', 'proj-team-a'] }]);
});

describe('/api/projects', () => {
  it('adopts, lists with attachment + myRole, patches, manages members and deletes', async () => {
    const created = await adopt(request('/api/projects', { method: 'POST', body: { computeQuotaId: 'q1' } }));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: 'team-a', namespace: 'hyperpod-ns-team-a', attachment: 'ATTACHED', myRole: 'project-admin' });

    const asMember = await list(request('/api/projects', { role: 'researcher', groups: ['researchers', 'proj-team-a'] }));
    expect(await asMember.json()).toEqual([expect.objectContaining({ id: 'team-a', myRole: 'researcher', attachment: 'ATTACHED' })]);
    const asStranger = await list(request('/api/projects', { role: 'researcher' }));
    expect(await asStranger.json()).toEqual([]);

    const patched = await patch(request('/api/projects/team-a', { method: 'PATCH', body: { name: 'Team A' } }), params({ id: 'team-a' }));
    expect(await patched.json()).toMatchObject({ name: 'Team A' });
    expect((await patch(request('/api/projects/team-a', { method: 'PATCH', role: 'researcher', groups: ['researchers', 'proj-team-a'], body: { name: 'x' } }), params({ id: 'team-a' }))).status).toBe(403);

    const listed = await members(request('/api/projects/team-a/members', { role: 'researcher', groups: ['viewers', 'proj-team-a-admin'] }), params({ id: 'team-a' }));
    expect(await listed.json()).toEqual({ members: [{ username: 'alice', subject: 'a-sub', email: 'a@x', role: 'researcher' }] });
    const put = await setMember(request('/api/projects/team-a/members/bob', { method: 'PUT', body: { role: 'member' } }), params({ id: 'team-a', username: 'bob' }));
    expect(put.status).toBe(200);
    expect(mocks.setProjectGroups).toHaveBeenCalledWith('bob', 'team-a', 'member');

    mocks.listComputeQuotas.mockResolvedValue([]); resetAttachmentCacheForTests();
    expect(await (await detail(request('/api/projects/team-a'), params({ id: 'team-a' }))).json()).toMatchObject({ attachment: 'DETACHED' });

    expect((await remove(request('/api/projects/team-a', { method: 'DELETE', role: 'researcher' }), params({ id: 'team-a' }))).status).toBe(403);
    expect((await remove(request('/api/projects/team-a', { method: 'DELETE' }), params({ id: 'team-a' }))).status).toBe(200);
    expect(await (await list(request('/api/projects'))).json()).toEqual([]);
  });
  it('rejects the legacy namespace body', async () => {
    const res = await adopt(request('/api/projects', { method: 'POST', body: { id: 'x', name: 'x', namespace: 'hyperpod-ns-x' } }));
    expect(res.status).toBe(400);
  });
});
```

If `resetConfigForTests`/env names for the HyperPod cluster differ, read `src/server/config.ts` and use the exact env var names it maps to `eks.hyperPodClusterName`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/projects/routes.test.ts`
Expected: FAIL (missing modules / old handlers).

- [ ] **Step 3: Implement routes**

`src/app/api/projects/route.ts`:
```ts
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
```

`src/app/api/projects/[id]/route.ts`:
```ts
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
```

`src/app/api/projects/[id]/members/route.ts`:
```ts
import { route } from '@/server/api';
import { listProjectMembers } from '@/server/auth/project-members';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ session, params }) => ({ members: await listProjectMembers(session, params.id) }));
```

`src/app/api/projects/[id]/members/[username]/route.ts`:
```ts
import { z } from 'zod';
import { body, route } from '@/server/api';
import { setProjectMembership } from '@/server/auth/project-members';
export const dynamic = 'force-dynamic';
const schema = z.object({ role: z.enum(['member', 'project-admin']).nullable() }).strict();
export const PUT = route<{ id: string; username: string }>('viewer', async ({ session, params, req }) => {
  const { role } = await body(req, schema);
  await setProjectMembership(session, params.id, params.username, role);
  return { ok: true };
}, { audit: 'project.members' });
```
(`'viewer'` as the route floor because a platform viewer holding `proj-<id>-admin` must be able to manage members; `resolveProject(..., 'project-admin')` inside does the real check.)

Create `src/server/auth/project-view.ts` as shown in Interfaces.

- [ ] **Step 4: Run route tests**

Run: `npx vitest run src/app/api/projects/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects src/server/auth/project-view.ts
git commit -m "feat(dashboard): project routes — adopt/list/detail/patch/delete and Cognito-group members

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Replace every `project.members` read (session paths)

**Files (modify):**
- `src/app/api/credentials/route.ts:11-13`
- `src/app/api/tokens/route.ts:9`
- `src/app/api/webhooks/route.ts:8-9`
- `src/app/api/me/route.ts:38`
- `src/app/api/templates/_shared.ts:22`
- `src/server/services/pipelines.ts:181,195-196`
- `src/server/services/pipeline-archives.ts:109,127`
- `src/server/services/models.ts:111-113,195,216-217`
- `src/server/services/devices.ts:172-173`
- `src/server/services/source-builds.ts:157`
- `src/server/services/sessions.ts:118,244`
- `src/server/services/credentials.ts:50-54`
- `src/server/auth/api-tokens.ts:44-51,77-83,97-103,145-155`
- `src/server/auth/request-policy.ts` (no change — uses `project.namespace`, still present)
- `src/app/api/k8s/namespaces/route.ts` (no change)

**Interfaces:**
- Consumes: `memberRole`, `isMember`, `canWriteIn`, `isProjectAdmin` (Task 4); `projectRoleFromGroups` (Task 1).

Rule table (apply mechanically; keep any leading `session.role !== 'viewer' &&` / `session.role === 'researcher' &&` platform condition as-is):

| Old | New |
|---|---|
| `['researcher', 'project-admin'].includes(project.members[X])` | `canWriteIn(session, project)` |
| `project.members[X] === 'project-admin'` | `isProjectAdmin(session, project)` |
| `Object.hasOwn(members, X)` / any-role check | `isMember(session, project)` |
| `project.members[X]` as a value | `memberRole(session, project)` |

- [ ] **Step 1: Route handlers**

`credentials/route.ts`:
```ts
    canWrite: session.role !== 'viewer' && canWriteIn(session, project),
    canShare: session.role !== 'viewer' && isProjectAdmin(session, project),
```
`tokens/route.ts`:
```ts
  const canWrite = session.role !== 'viewer' && canWriteIn(session, project);
```
`webhooks/route.ts`:
```ts
    canManage: session.authMethod !== 'token' && !session.tokenProjectId &&
      (session.role === 'admin' || session.role === 'researcher' && isProjectAdmin(session, project)) };
```
`me/route.ts`:
```ts
    project: project ? { id: project.id, name: project.name, role: memberRole(session, project) } : undefined,
```
`templates/_shared.ts`:
```ts
  if (!owner && session.role !== 'admin' && !(project && isProjectAdmin(session, project))) throw forbidden('Only the template owner or a project/platform administrator can change it');
```
Add the corresponding imports from `@/server/auth/projects` in each file.

- [ ] **Step 2: Services**

`pipelines.ts`:
```ts
  if (write && record.ownerSubject !== subject(session) && session.role !== 'admin' && !isProjectAdmin(session, project)) throw forbidden('실행 소유자 또는 프로젝트 관리자가 중단할 수 있습니다.');
…
      (session.role === 'admin' || session.role === 'researcher' && canWriteIn(session, project)),
    canStop: Boolean(record) && (record?.ownerSubject === subject(session) || session.role === 'admin' || isProjectAdmin(session, project)) };
```
`pipeline-archives.ts` (both sites):
```ts
    if (record.ownerSubject !== principal(session) && session.role !== 'admin' && !isProjectAdmin(session, project)) throw forbidden('Only the archive owner or project administrator may retry it');
```
`models.ts` — change the helper and its callers:
```ts
  private canWrite(session: Session, project: Pick<Project, 'id'>) {
    return session.role === 'admin' || session.role === 'researcher' && canWriteIn(session, project);
  }
…
    return { projectId, canWrite: this.canWrite(session, project),
…
    return { model, canWrite: this.canWrite(session, project),
      canPropagateRegistry: session.role === 'admin' || isProjectAdmin(session, project),
```
`devices.ts`:
```ts
      canWrite: session.role === 'admin' || session.role === 'researcher' && canWriteIn(session, project),
      canRegister: session.role === 'admin' || session.role === 'researcher' && isProjectAdmin(session, project) };
```
`source-builds.ts`:
```ts
    if (row.actor !== session.subject && session.role !== 'admin' && !isProjectAdmin(session, p)) throw forbidden('Only the requester or project administrator can stop this build');
```
`sessions.ts` line 118:
```ts
  if (project.namespace !== s.namespace || backendId(project.backendId) !== backendId(s.backendId) || project.backendConfigHash !== s.backendConfigHash || !canWriteIn(p, project)) throw forbidden('Current project researcher membership and backend binding are required');
```
`sessions.ts` line 244:
```ts
  if (!canWriteIn(principal, project) || !/^hyperpod-ns-/.test(project.namespace) || !dns.test(project.queue)) throw forbidden('A governed project and researcher membership are required');
```
(`Principal` in sessions.ts must be assignable to `Session` for these helpers; if it is a narrower type, widen it to `Session` or add `groups?: string[]` to it.)

`credentials.ts` — replace the `membership` function body:
```ts
async function membership(principal: CredentialPrincipal, project: Project, deps: CredentialDeps, write = false) {
  if (!principal.subject || !/^[a-z][a-z0-9-]{0,39}$/.test(project.id) || principal.tokenProjectId && principal.tokenProjectId !== project.id) throw forbidden();
  if (!(await deps.kv.get(`PROJECT#${project.id}`, 'META'))) throw forbidden('현재 프로젝트 권한이 필요합니다.');
  const role = memberRole(principal, project);
  if (!role || write && (role === 'viewer' || principal.role === 'viewer')) throw forbidden('현재 프로젝트 권한이 필요합니다.');
  return role;
}
```
(`CredentialPrincipal` must include `role`, `groups?`, `tokenProjectId?` — extend it to `Session`-compatible if needed.)

- [ ] **Step 3: `api-tokens.ts`**

Replace `projectMembership` and its callers:
```ts
function projectMembership(groups: readonly string[] | undefined, projectId: string): ProjectRole {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(projectId)) throw forbidden();
  const role = projectRoleFromGroups(groups, projectId);
  if (!role) throw forbidden('현재 프로젝트 멤버십이 필요합니다.');
  return role;
}
async function assertProjectExists(projectId: string, deps: ApiTokenDeps) {
  if (!(await deps.kv.get(`PROJECT#${projectId}`, 'META'))) throw forbidden('현재 프로젝트 멤버십이 필요합니다.');
}
```
- `createApiToken`: `await assertProjectExists(project.id, deps); const user = await current(...); const membership = projectMembership(user.groups, project.id);`
- `listApiTokens` / `revokeApiToken`: replace `await projectMembership(project.id, principal.subject!, deps)` with `await assertProjectExists(project.id, deps); projectMembership(principal.groups, project.id);`
- `verifyApiToken`: `await assertProjectExists(record.projectId, deps); const membership = projectMembership(user.groups, record.projectId);`
- Update imports: `import { projectRoleFromGroups, roleFromGroups, type ProjectRole } from './rbac';` and drop the `Project`/`ProjectRole` import from `./projects` if unused (keep `Project` — it's a parameter type).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: remaining errors only in `logs/auth.ts`, `gateway/auth.ts`, `gateway/token-grants.ts` (Task 8) and in test/fixture files (Task 9). If any *other* file still errors, it is a missed call site — fix it with the rule table.

- [ ] **Step 5: Commit**

```bash
git add -A src/app src/server/services src/server/auth/api-tokens.ts
git commit -m "refactor(dashboard): replace project.members reads with memberRole helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Token, gateway and log authorization from fresh Cognito groups

**Files:**
- Modify: `src/server/logs/auth.ts:40-45`
- Modify: `src/server/gateway/auth.ts:70-76`
- Modify: `src/server/gateway/token-grants.ts:94-98`
- Tests: existing `src/server/logs/stream.test.ts`, `src/server/gateway/auth.test.ts`, `src/server/gateway/token-grants.test.ts` (update fixtures in Task 9; here only make the code compile and keep the semantics).

**Interfaces:**
- Consumes: `projectRoleFromGroups`; `projectFromItem`, `namespaceOf` (Task 4); `AuthOptions.currentUser`.

- [ ] **Step 1: `logs/auth.ts`**

Replace lines 40–45 with:
```ts
  const projectItem = await deps.repo.kv.get(`PROJECT#${wf.projectId}`, 'META');
  const project = projectItem ? projectFromItem(projectItem) : undefined;
  const membership = projectRoleFromGroups(user.groups, wf.projectId);
  const actualAdmin = !marked && p.role === 'admin' && roleFromGroups(user.groups) === 'admin';
  if (!project || project.namespace !== wf.namespace || backendId(project.backendId) !== backendId(wf.backendId) ||
    project.backendConfigHash !== wf.backendConfigHash || !actualAdmin && !membership) throw fail();
```
Import: `import { projectRoleFromGroups, roleFromGroups } from '../auth/rbac';` and `import { projectFromItem } from '../auth/projects';`.

- [ ] **Step 2: `gateway/auth.ts`**

Replace the `if (s.projectId && !hasTokenBinding(s)) { … }` block with:
```ts
  if (s.projectId && !hasTokenBinding(s)) {
    const item = await repo.kv.get(`PROJECT#${s.projectId}`, 'META');
    const project = item ? projectFromItem(item) : undefined;
    if (!project || project.namespace !== s.namespace || typeof s.owner !== 'string' || !s.owner) throw invalid();
    let user;
    try { user = await (options.currentUser ?? currentUserAuthorization)(s.owner); } catch { throw invalid(); }
    if (!user.enabled || user.subject !== s.ownerSubject) throw invalid();
    const role = projectRoleFromGroups(user.groups, s.projectId);
    if (role !== 'researcher' && role !== 'project-admin') throw invalid();
  }
```
Imports: `import { projectRoleFromGroups } from '../auth/rbac'; import { projectFromItem } from '../auth/projects'; import { currentUserAuthorization } from '../aws/cognito';`. `GatewaySession` is the store `Session` which has `owner: string`.

- [ ] **Step 3: `gateway/token-grants.ts`**

Replace lines 94–98 with:
```ts
    const item = await repo.kv.get(`PROJECT#${expected.projectId}`, 'META');
    const project = item ? projectFromItem(item) : undefined;
    const role = projectRoleFromGroups(user.groups, expected.projectId);
    if (!project || expected.namespace !== undefined && project.namespace !== expected.namespace ||
      role !== 'researcher' && role !== 'project-admin') throw invalid();
```
Imports: `projectRoleFromGroups` from `../auth/rbac`, `projectFromItem` from `../auth/projects`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `*.test.ts` / fixture files.

- [ ] **Step 5: Commit**

```bash
git add src/server/logs/auth.ts src/server/gateway/auth.ts src/server/gateway/token-grants.ts
git commit -m "refactor(dashboard): token/gateway/log auth read project role from fresh Cognito groups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Migrate fixtures and tests; full suite green

**Files:**
- Modify: `src/server/gateway/token-fixtures.test-helpers.ts`, `src/server/evaluations/pipeline-fixtures.ts`, `src/app/api/edge/fixtures.ts`, `src/server/auth/api-tokens.test.ts`, `src/app/api/project-boundaries.test.ts`, and every file `npm run typecheck` still lists.

**Interfaces:**
- Consumes: `testSession`, `projectFixture`, `putProject` (Task 4).

Migration rules:
1. Replace `Project` literals with `projectFixture(id, { …overrides })`. Remove `members`, `namespace`, `queue` keys (derived).
2. Where a test needs a user to be a member, add the group to the **session** (`testSession(user, subject, role, ['proj-<id>'])` or `['proj-<id>-admin']`) and, for token/gateway/log tests, to the mocked `currentUser().groups`.
3. Where a test previously *removed* membership by rewriting `members: {}`, instead change the mocked `currentUser` groups (token paths) or use a session without the group (browser paths).
4. Any mocked LocalQueue name must become `hyperpod-ns-<id>-localqueue` (e.g. `q-a` → `hyperpod-ns-a-localqueue`) because `project.queue` is now derived.
5. Any assertion on `role: 'project-admin'` for a platform admin stays valid (`memberRole` returns `project-admin` for admins).

- [ ] **Step 1: `token-fixtures.test-helpers.ts`**

```ts
  const browser = { subject: 'subject-a', user: 'alice', email: 'alice@example.invalid', role: 'researcher' as const, groups: ['researchers', 'proj-team-a'] };
  const project = projectFixture('team-a');
  await repo.kv.put(projectItem(project));
  const state = { now: Date.now(), failUser: false, user: { username: 'alice', subject: 'subject-a', email: '', enabled: true, groups: ['researchers', 'proj-team-a'] } as CurrentUserAuthorization };
```
(import `projectFixture` from `../auth/session.test-helpers` and `projectItem` from `../auth/projects`.)

- [ ] **Step 2: `pipeline-fixtures.ts` and `edge/fixtures.ts`**

Replace the two `PROJECT#a`/`PROJECT#b` puts with `await putProject(repo.kv, 'a'); await putProject(repo.kv, 'b');`. Sessions used in those suites (`alice`, `reader`, `peer`, `bob`) must carry groups: alice `['proj-a-admin']`, reader `['proj-a']` with platform role viewer, peer `['proj-a']`, bob `['proj-b']`. Find where these session constants are defined (grep `alice-sub` in `src/server/evaluations` and `src/app/api/edge`) and switch them to `testSession(...)`. In `edge/fixtures.ts` delete the `project.members = …; await base.repo.kv.put(project);` lines.

- [ ] **Step 3: `api-tokens.test.ts`**

- `principal` → `testSession('alice', 'sub-a', 'researcher', ['proj-a-admin'])` (it was `project-admin`).
- `project` → `projectFixture('a')`; the `kv.put` line → `await kv.put(projectItem(project));`.
- Every `currentUser` mock gains `'proj-a-admin'` in `groups` where membership is expected. In the "honors group and project downgrades" test, replace `await kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, members: {} });` with `deps.currentUser = vi.fn(async () => ({ username: 'alice', subject: 'sub-a', email: '', enabled: true, groups: ['researchers'] }));` (member group removed ⇒ 403).

- [ ] **Step 4: `project-boundaries.test.ts`**

- `project` → `projectFixture('a')`, put via `projectItem`. Project `b` → `putProject(repo.kv, 'b')`.
- `principal` → `{ user: 'alice', subject: 'sub-a', email: '', role: 'researcher' as const, groups: ['researchers', 'proj-a'] }`.
- `browserRequest` adds header `'x-pai-groups': 'researchers,proj-a'`.
- `mocks.currentUser` groups → `['researchers', 'proj-a']`.
- LocalQueue mock names `q-a`/`q-b` → `hyperpod-ns-a-localqueue` / `hyperpod-ns-b-localqueue`; any assertion on `queue: 'q-a'` follows.
- The `tokenRequest` helper additionally asserts `expect(headers.get('x-pai-groups')).toContain('proj-a')`.

- [ ] **Step 5: Everything else the typechecker lists**

Run `npm run typecheck`; for each remaining file apply the migration rules. Then run `npm test` and fix behavioural fallout the same way (the usual failure is "session has no groups ⇒ 403" — add the group to the session/currentUser mock).

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: both clean. Browser tests (`*.browser.test.ts`) skip automatically when Chromium is absent — that is acceptable here; Task 10 adds the new one.

- [ ] **Step 7: Commit**

```bash
git add -A src
git commit -m "test(dashboard): fixtures and suites use Cognito-group membership and derived queues

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: UI — adopt a team, attachment badge, members, delete; switcher/sessions/queues; i18n

**Files:**
- Rewrite: `src/components/pages/ProjectsPage.tsx`
- Modify: `src/components/pages/backend-ui.ts:121,134-141` (replace `projectQueues` with `adoptableQuotas`)
- Modify: `src/components/pages/SessionsPage.tsx:17,49`
- Modify: `src/components/layout/ProjectSwitcher.tsx`
- Modify: `src/components/pages/QueuesPage.tsx:416-469` (project column)
- Modify: `src/lib/i18n/messages/projects.ts`, `queues.ts`, `nav.ts`
- Test: `src/components/pages/ProjectsPage.browser.test.ts` (create; pattern from `BackendsPage.browser.test.ts`)

**Interfaces:**
- Consumes HTTP from Task 6; `GET /api/quotas?backendId=` (existing) returning `{ clusterArn, quotas: Array<{ ComputeQuotaId, Name, Status, ComputeQuotaTarget?: { TeamName, FairShareWeight }, detail?: { ComputeQuotaConfig?: { ComputeQuotaResources?: Array<{ InstanceType, Count }> } } }> }`.
- Browser DTO (define in `backend-ui.ts`): `export interface ProjectRow { id: string; name: string; namespace: string; queue: string; backendId?: string; computeQuotaId: string; description?: string; myRole?: 'viewer' | 'researcher' | 'project-admin'; attachment: 'ATTACHED' | 'DETACHED' | 'UNKNOWN' }`.

- [ ] **Step 1: i18n**

`projects.ts` — add to `en`:
```ts
    adoptTeam: 'Adopt a team', adoptTeamDesc: 'A project is a HyperPod task-governance team (ComputeQuota). Pick a team that has not been adopted yet; its namespace and queue are derived from the team name. Backend binding cannot be changed later.',
    team: 'Team (ComputeQuota)', teamSelect: 'Select team', noAdoptableQuotas: 'Every ComputeQuota on this backend is already adopted, or none exist. Create a team in Compute quotas first.',
    fetchingQuotas: 'Loading ComputeQuotas…', adopt: 'Adopt as project', projectAdopted: 'Team adopted as a project. Add members to start research.',
    attachment: 'Binding', attached: 'ATTACHED', detached: 'DETACHED', unknown: 'UNKNOWN',
    detachedHint: 'The ComputeQuota behind this project no longer exists or its team was renamed. Past results stay visible; new runs cannot be queued.',
    memberRoleMember: 'Member', memberRoleAdmin: 'Project admin', memberRemove: 'Remove',
    platformRoleHint: 'Read vs. run permission comes from the platform role (researchers group). Project admins manage members.',
    addMember: 'Add member', addMemberUsername: 'Cognito username', membershipSaved: 'Membership updated. It applies after the user\'s next token refresh.',
    deleteProject: 'Delete project', deleteConfirm: 'Delete the project record and its two Cognito groups? The ComputeQuota, workflows, datasets and storage are kept.',
    projectDeleted: 'Project deleted.', namespace: 'Namespace', queue: 'Queue', quotaId: 'ComputeQuota',
```
and to `ko`:
```ts
    adoptTeam: '팀 채택', adoptTeamDesc: '프로젝트는 HyperPod Task Governance 팀(ComputeQuota)입니다. 아직 채택되지 않은 팀을 선택하면 네임스페이스와 큐는 팀 이름에서 파생됩니다. backend 연결은 이후 변경할 수 없습니다.',
    team: '팀 (ComputeQuota)', teamSelect: '팀 선택', noAdoptableQuotas: '이 backend의 ComputeQuota가 모두 채택되었거나 없습니다. 먼저 Compute Quotas에서 팀을 만드세요.',
    fetchingQuotas: 'ComputeQuota를 불러오는 중…', adopt: '프로젝트로 채택', projectAdopted: '팀을 프로젝트로 채택했습니다. 구성원을 추가하면 연구를 시작할 수 있습니다.',
    attachment: '바인딩', attached: 'ATTACHED', detached: 'DETACHED', unknown: 'UNKNOWN',
    detachedHint: '이 프로젝트의 ComputeQuota가 삭제되었거나 팀 이름이 바뀌었습니다. 과거 결과는 계속 볼 수 있지만 새 실행은 큐에 넣을 수 없습니다.',
    memberRoleMember: '멤버', memberRoleAdmin: '프로젝트 관리자', memberRemove: '제외',
    platformRoleHint: '조회/실행 권한은 플랫폼 역할(researchers 그룹)이 결정합니다. 프로젝트 관리자는 구성원을 관리합니다.',
    addMember: '구성원 추가', addMemberUsername: 'Cognito 사용자 이름', membershipSaved: '구성원을 변경했습니다. 해당 사용자의 다음 토큰 갱신부터 적용됩니다.',
    deleteProject: '프로젝트 삭제', deleteConfirm: '프로젝트 레코드와 Cognito 그룹 2개를 삭제할까요? ComputeQuota, 워크플로우, 데이터셋, 스토리지는 유지됩니다.',
    projectDeleted: '프로젝트를 삭제했습니다.', namespace: '네임스페이스', queue: '큐', quotaId: 'ComputeQuota',
```
Remove the now-unused keys `newProject`, `newProjectDesc`, `projectId`, `resourcePool`, `poolSelect`, `createProject`, `projectCreated`, `membersSaved`, `fetchingQueues`, `noQueues`, `viewer`, `researcher`, `projectAdmin`, `noRole` **only if** `grep -rn "t('<key>')" src` shows no other user (otherwise keep).

`queues.ts` — add `project: 'Project'` / `'프로젝트'`, `adoptLink: 'Adopt'` / `'채택'`, `notAdopted: 'Not adopted'` / `'미채택'` to both locales.

`nav.ts` — add `detached: 'binding lost'` / `'바인딩 끊김'`.

- [ ] **Step 2: `backend-ui.ts`**

Replace `BackendQueue` + `projectQueues` with:
```ts
export interface ProjectRow { id: string; name: string; namespace: string; queue: string; backendId?: string; computeQuotaId: string; description?: string; myRole?: 'viewer' | 'researcher' | 'project-admin'; attachment: 'ATTACHED' | 'DETACHED' | 'UNKNOWN' }
export interface QuotaRow { ComputeQuotaId: string; Name?: string; Status?: string; ComputeQuotaTarget?: { TeamName?: string; FairShareWeight?: number }; detail?: { ComputeQuotaConfig?: { ComputeQuotaResources?: Array<{ InstanceType?: string; Count?: number }> } } }
const teamPattern = /^[a-z][a-z0-9-]{0,39}$/;
/** Quotas on a READY backend whose team is not yet adopted and whose namespace the backend allows. */
export function adoptableQuotas(registry: BackendRegistry | undefined, id: string, quotas: QuotaRow[] | undefined, projects: Array<{ computeQuotaId: string; id: string }>) {
  if (!backendAvailable(registry, id) || !quotas) return [];
  const allowed = id === 'default' ? undefined : registry?.backends.find(row => row.id === id)?.profile?.namespaces;
  return quotas.filter(q => {
    const team = q.ComputeQuotaTarget?.TeamName ?? '';
    return teamPattern.test(team) && (id === 'default' || allowed?.includes(`hyperpod-ns-${team}`)) &&
      !projects.some(p => p.computeQuotaId === q.ComputeQuotaId || p.id === team);
  });
}
export const quotaLabel = (q: QuotaRow) => `${q.ComputeQuotaTarget?.TeamName ?? '?'} · ${(q.detail?.ComputeQuotaConfig?.ComputeQuotaResources ?? []).map(r => `${r.InstanceType}×${r.Count}`).join(', ') || '—'} · fair-share ${q.ComputeQuotaTarget?.FairShareWeight ?? '—'}`;
```
Fix `BackendsPage.browser.test.ts`'s `Project` type alias to `ProjectRow` shape (add `computeQuotaId`, `attachment`, drop `members`).

- [ ] **Step 3: `ProjectsPage.tsx`**

```tsx
'use client';
import * as React from 'react';
import { api, useApi, useMe } from '@/lib/api-client';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, LinkButton, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { adoptableQuotas, backendAvailable, backendStatus, quotaLabel, type BackendRegistry, type ProjectRow, type QuotaRow } from './backend-ui';

interface Member { username: string; subject?: string; email?: string; role: 'viewer' | 'researcher' | 'project-admin' }
const tone = (attachment: ProjectRow['attachment']) => attachment === 'ATTACHED' ? 'ok' : attachment === 'DETACHED' ? 'warn' : 'neutral';

export function ProjectsPage() {
  const t = useT('projects');
  const tc = useT('common');
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const projects = useApi<ProjectRow[]>('/api/projects');
  const backends = useApi<BackendRegistry>(isAdmin ? '/api/backends' : null, { refetch: 15000 });
  const [backendId, setBackendId] = React.useState('default');
  const [quotaId, setQuotaId] = React.useState('');
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('backendId'), quota = params.get('quota');
    if (requested && /^[a-z][a-z0-9-]{0,39}$/.test(requested)) setBackendId(requested);
    if (quota && /^[A-Za-z0-9-]{1,128}$/.test(quota)) setQuotaId(quota);
  }, []);
  const backendReady = !backends.error && backendAvailable(backends.data, backendId);
  const quotas = useApi<{ quotas: QuotaRow[] }>(isAdmin && backendReady ? `/api/quotas?backendId=${encodeURIComponent(backendId)}` : null, { refetch: 15000 });
  const [selected, setSelected] = React.useState<string>();
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [newMember, setNewMember] = React.useState('');
  const project = projects.data?.find((item) => item.id === selected);
  const canManage = !!project && (isAdmin || project.myRole === 'project-admin');
  const members = useApi<{ members: Member[] }>(canManage ? `/api/projects/${encodeURIComponent(project.id)}/members` : null);
  const candidates = quotas.error || projects.error ? [] : adoptableQuotas(backends.data, backendId, quotas.data?.quotas, projects.data ?? []);
  const canAdopt = isAdmin && backendReady && !!projects.data && !projects.error && !quotas.error && !quotas.isFetching && candidates.some((q) => q.ComputeQuotaId === quotaId) && !busy;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(undefined); setMessage('');
    try { await action(); setMessage(success); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const adopt = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!canAdopt) return;
    const form = event.currentTarget; const name = String(new FormData(form).get('name') ?? '').trim();
    void run(async () => {
      const created = await api<ProjectRow>('/api/projects', { method: 'POST', json: { computeQuotaId: quotaId, backendId, ...(name ? { name } : {}) } });
      form.reset(); setQuotaId(''); await projects.refetch(); setSelected(created.id);
    }, t('projectAdopted'));
  };
  const setRole = (username: string, role: 'member' | 'project-admin' | null) => project && run(async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(username)}`, { method: 'PUT', json: { role } });
    setNewMember(''); await members.refetch();
  }, t('membershipSaved'));
  const remove = () => project && run(async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    setConfirmDelete(false); setSelected(undefined); await projects.refetch();
  }, t('projectDeleted'));

  return <>
    <PageHeader title={t('title')} description={t('projectManagementHint')} />
    {message && <p role="status" className="mb-4 text-sm text-ok">{message}</p>}
    {(error || projects.error) && <ErrorBox error={error ?? projects.error} />}
    <ErrorBox error={me.error} />
    {projects.isLoading && <Spinner label={t('loadingProjects')} />}
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Card title={t('projectList')}>
        {!projects.data?.length && <EmptyState title={t('noProjects')} hint={isAdmin ? t('noAdoptableQuotas') : t('noProjectsHint')} />}
        <div className="space-y-2">{projects.data?.map((item) => <button key={item.id}
          className={`w-full rounded-lg border p-4 text-left ${selected === item.id ? 'border-accent bg-accent/5' : 'border-border bg-bg'}`}
          onClick={() => setSelected(item.id)}>
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{item.name}</span><Badge tone={tone(item.attachment)}>{t(item.attachment.toLowerCase() as 'attached' | 'detached' | 'unknown')}</Badge></div>
          <p className="mt-1 text-xs text-fg-muted">{item.description ?? item.id}</p>
          <p className="mt-3 truncate text-xs text-fg-faint">backend: {item.backendId ?? 'default'} · {t('team')}: {item.id} · {t('quotaId')}: {item.computeQuotaId}</p>
        </button>)}</div>
      </Card>
      <Card title={project ? `${project.name} · ${t('projectMembers')}` : t('projectMembers')}
        actions={project && isAdmin ? <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>{t('deleteProject')}</Button> : undefined}>
        {!project ? <EmptyState title={t('selectProjectPrompt')} /> : <>
          {project.attachment === 'DETACHED' && <p className="mb-3 text-xs text-warn">{t('detachedHint')}</p>}
          <dl className="mb-4 grid grid-cols-2 gap-2 text-xs text-fg-muted">
            <dt>{t('namespace')}</dt><dd className="mono">{project.namespace}</dd>
            <dt>{t('queue')}</dt><dd className="mono">{project.queue}</dd>
          </dl>
          {!canManage ? <p className="text-sm text-fg-muted">{t('notAdmin')}</p> : <>
            <p className="mb-4 text-xs text-fg-muted">{t('platformRoleHint')}</p>
            {members.isLoading && <Spinner label={tc('loading')} />}
            <ErrorBox error={members.error} />
            <div className="space-y-3">{members.data?.members.map((member) => <div key={member.username} className="flex items-center justify-between gap-4 rounded border border-border bg-bg p-3">
              <span className="min-w-0 text-sm"><span className="block truncate">{member.username}</span><span className="block truncate text-xs text-fg-muted">{member.email}</span></span>
              <select aria-label={`${member.username} ${t('role')}`} className="rounded border border-border bg-bg-elev px-2 py-1.5 text-xs" disabled={busy}
                value={member.role === 'project-admin' ? 'project-admin' : 'member'}
                onChange={(event) => void setRole(member.username, event.target.value === '' ? null : event.target.value as 'member' | 'project-admin')}>
                <option value="member">{t('memberRoleMember')}</option><option value="project-admin">{t('memberRoleAdmin')}</option><option value="">{t('memberRemove')}</option>
              </select>
            </div>)}</div>
            <form className="mt-4 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (newMember.trim()) void setRole(newMember.trim(), 'member'); }}>
              <label className="grow text-xs text-fg-muted">{t('addMemberUsername')}<input value={newMember} onChange={(event) => setNewMember(event.target.value)} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" /></label>
              <Button type="submit" variant="primary" disabled={busy || !newMember.trim()}>{t('addMember')}</Button>
            </form>
          </>}
        </>}
      </Card>
    </div>
    {isAdmin && <Card title={t('adoptTeam')} className="mt-5" actions={<LinkButton href="/backends" size="sm">{t('backends')}</LinkButton>}>
      <p className="mb-4 text-xs leading-5 text-fg-muted">{t('adoptTeamDesc')}</p>
      <form onSubmit={adopt} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs text-fg-muted">{t('runBackend')}<select name="backendId" value={backendId} disabled={busy || backends.isLoading || !!backends.error} required
          className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" onChange={(event) => { setBackendId(event.target.value); setQuotaId(''); setError(undefined); setMessage(''); }}>
          <option value="default" disabled={!backends.data?.default?.configured}>{t('defaultEks')}</option>
          {backends.data?.backends?.map((row) => <option key={row.id} value={row.id} disabled={!backendAvailable(backends.data, row.id)}>{row.id} · {backendStatus(row.status).label}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">{t('team')}<select name="computeQuotaId" value={quotaId} onChange={(event) => setQuotaId(event.target.value)} disabled={busy || !backendReady || quotas.isFetching || !!quotas.error || !!projects.error} required className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm">
          <option value="">{t('teamSelect')}</option>{candidates.map((q) => <option key={q.ComputeQuotaId} value={q.ComputeQuotaId}>{quotaLabel(q)}</option>)}
        </select></label>
        <label className="text-xs text-fg-muted">{t('projectName')}<input name="name" maxLength={100} disabled={busy} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-sm" placeholder={candidates.find((q) => q.ComputeQuotaId === quotaId)?.ComputeQuotaTarget?.TeamName ?? ''} /></label>
        <Button type="submit" loading={busy} disabled={!canAdopt} variant="primary">{t('adopt')}</Button>
      </form>
      <ErrorBox error={backends.error} /><ErrorBox error={quotas.error} />
      {backends.isLoading && <Spinner label={t('selectBackend')} />}
      {!backends.isLoading && !backends.error && !backendReady && <p className="mt-3 text-sm text-fg-muted">{t('backendUnready')}</p>}
      {quotas.isFetching && <Spinner label={t('fetchingQuotas')} />}
      {backendReady && !quotas.isFetching && !quotas.error && !projects.error && quotas.data && candidates.length === 0 && <p className="mt-3 text-sm text-fg-muted">{t('noAdoptableQuotas')}</p>}
    </Card>}
    {confirmDelete && project && <Dialog open onClose={() => setConfirmDelete(false)} title={t('deleteProject')}>
      <p className="text-sm">{t('deleteConfirm')}</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirmDelete(false)}>{tc('cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void remove()}>{tc('delete')}</Button></div>
    </Dialog>}
  </>;
}
```
Check that `Badge` accepts `tone="neutral"` and `Card` accepts `actions`; if `Badge` tones are `'ok' | 'warn' | 'info' | 'err'`, map `UNKNOWN` to `'info'`. Check `tc('loading')`, `tc('cancel')`, `tc('delete')` exist in `common` messages; add if missing.

- [ ] **Step 4: `SessionsPage.tsx`**

Line 17 → `interface Project { id: string; name: string; namespace: string; queue: string; myRole?: 'viewer' | 'researcher' | 'project-admin' }` and line 49 → `const eligibleProjects = (projects.data ?? []).filter((p) => p.myRole === 'researcher' || p.myRole === 'project-admin');` (drop the now-unused `profile?.subject` condition only if `profile` is not used elsewhere in the file).

- [ ] **Step 5: `ProjectSwitcher.tsx`**

`useApi<Array<{ id: string; name: string; attachment?: string }>>` and render `{project.name}{project.attachment === 'DETACHED' ? ` ⚠ ${t('detached')}` : ''}` inside the `<option>`.

- [ ] **Step 6: `QueuesPage.tsx` project column**

Add `const projects = useApi<Array<{ id: string; computeQuotaId: string; name: string }>>('/api/projects');` next to the other queries. In the quotas table header insert `<th className="px-3 py-2 text-left font-medium">{t('project')}</th>` after the team column, and in each row after the team cell:
```tsx
                        <td className="px-3 py-2">{(() => { const p = projects.data?.find((x) => x.computeQuotaId === q.ComputeQuotaId); return p
                          ? <a className="underline" href="/projects">{p.name}</a>
                          : can(me, 'admin') ? <a className="underline" href={`/projects?quota=${encodeURIComponent(q.ComputeQuotaId)}`}>{t('adoptLink')}</a> : <span className="text-fg-muted">{t('notAdopted')}</span>; })()}</td>
```

- [ ] **Step 7: Browser test**

Create `src/components/pages/ProjectsPage.browser.test.ts` following `BackendsPage.browser.test.ts` (same esbuild bundle + fixture HTTP server pattern; bundle only `ProjectsPage`). Fixture routes: `/api/me` (admin or researcher), `/api/projects` (two projects, one `DETACHED`), `/api/backends` (default configured), `/api/quotas?backendId=default` (three quotas: one already adopted, one team `9lives`, one adoptable `team-c`), `/api/projects/team-a/members`, and record `POST /api/projects`, `PUT /api/projects/team-a/members/bob`, `DELETE /api/projects/team-a`. Assertions:
1. Team dropdown lists exactly one option besides the placeholder, labelled with `team-c`.
2. Selecting it and submitting posts `{ computeQuotaId: 'q-c', backendId: 'default' }`.
3. The `team-b` card shows the `DETACHED` badge and, when selected, the detached hint text.
4. Selecting `team-a` shows the member `alice` with role `member`; typing `bob` and clicking add issues `PUT …/members/bob` with `{ role: 'member' }`.
5. As a non-admin researcher with `myRole: 'researcher'`, the adopt card is absent and the members panel shows the `notAdmin` text.

Run: `npx vitest run src/components/pages/ProjectsPage.browser.test.ts` (skips without Chromium — then at least run `npm run typecheck`).

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add -A src
git commit -m "feat(dashboard): projects UI adopts HyperPod teams, shows binding status, manages Cognito-group members

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Infra IAM, dev env docs, reset runbook

**Files:**
- Modify: `infra/lib/dashboard-stack.ts:420-433`
- Modify: `web/README.md` (or wherever `AUTH_MODE=dev` is documented — `grep -rn "AUTH_MODE" --include=*.md`)
- Create: `docs/runbooks/2026-09-20-project-reset.md`

- [ ] **Step 1: IAM**

In the `CognitoUserAdmin` statement add:
```ts
          'cognito-idp:CreateGroup',
          'cognito-idp:DeleteGroup',
          'cognito-idp:GetGroup',
```
Run from `dashboard/infra`: `npm test` (per repo memory the CDK tests run with `node --require ts-node/register --test test/<file>.test.ts`; use the package script if one exists). If `template-parity.test.ts` fails because the synthesized template changed, follow the instruction printed by that test to refresh its fixture, and include the fixture in the commit.

- [ ] **Step 2: Dev env docs**

Replace every `DEV_ROLE` mention with `DEV_GROUPS` and add one sentence: `DEV_GROUPS` is a comma-separated Cognito group list, e.g. `admins` (default) or `researchers,proj-team-a`.

- [ ] **Step 3: Runbook**

```markdown
# Runbook — reset projects to the ComputeQuota-adoption model (2026-09-20)

Applies once, when deploying the "project = HyperPod team" change to an environment that still has the
legacy `workshop` project (namespace `hyperpod-ns-team-a`).

## Before deploying
1. Confirm no RUNNING workflows or open sessions: dashboard › Runs, Sessions.
2. Note the table name: `aws cloudformation describe-stacks --stack-name <dashboard-stack> --query "Stacks[0].Outputs"` (or `/api/me` → `resources.table`).

## Deploy
3. `cd dashboard/infra && npx cdk deploy` (adds Cognito CreateGroup/DeleteGroup/GetGroup to the web task role).

## Remove the legacy records
```bash
TABLE=<table-name>
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT#workshop"},"sk":{"S":"META"}}'
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT_NAMESPACE#hyperpod-ns-team-a"},"sk":{"S":"OWNER"}}'
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT_NAMESPACE#default#hyperpod-ns-team-a"},"sk":{"S":"OWNER"}}'
```
Workflows/datasets/templates that carry `projectId: workshop` stay in the table and remain visible to platform admins only. S3/FSx prefixes `projects/workshop/…` are not moved.

## Adopt the team
4. Sign in as a platform admin → Projects → *Adopt a team* → backend `default` → pick the `team-a` ComputeQuota → Adopt.
5. Projects → `team-a` → add each researcher by Cognito username (role *Member*; team leads *Project admin*).
6. Ask users to sign out and back in (or wait for the access-token refresh) so `proj-team-a` appears in their session.

## Verify
7. `/api/projects` shows `team-a` with `attachment: ATTACHED`.
8. A researcher can submit a workflow; Queues shows it under `hyperpod-ns-team-a-localqueue`.
```

- [ ] **Step 4: Commit**

```bash
git add infra/lib/dashboard-stack.ts infra/test web/README.md docs/runbooks/2026-09-20-project-reset.md
git commit -m "chore(dashboard): Cognito group IAM for project adoption, DEV_GROUPS docs, project reset runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Final verification

- [ ] **Step 1: Grep for leftovers**

Run from `dashboard/web`:
```bash
grep -rn "\.members\[" src --include=*.ts --include=*.tsx | grep -v "group\.\|device\.\|d\.members\|ctx\.group\|thing" ; grep -rn "ensureDefaultProject\|updateProjectMembers\|projectInputSchema\|DEV_ROLE" src
```
Expected: no output.

- [ ] **Step 2: Full gates**

Run: `npm run typecheck && npm test && (cd ../infra && npm test)`
Expected: all green. Paste the summary lines into the final report.

- [ ] **Step 3: Spec cross-check**

Open the spec and tick each of sections 1–7 against the commits above; anything unimplemented becomes a follow-up note at the bottom of the spec under `## 후속`.
