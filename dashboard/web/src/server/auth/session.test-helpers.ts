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
