import { backendCapabilities, type BackendProfile } from './registry';
import type { Session } from '../auth/session';

export const admin: Session = { user: 'admin', subject: 'admin-sub', email: 'admin@test', role: 'admin', authMethod: 'alb' };
export function profile(id: string): BackendProfile {
  return { id, configVersion: 1, accountId: '123456789012', region: 'us-east-1', vpcId: 'vpc-1234',
    eks: { eksClusterName: `eks-${id}`, hyperPodClusterName: `hp-${id}`, dataBucket: `data-${id}`, fsxFileSystemId: `fs-${id}`, fsxDnsName: `${id}.fsx.test`, fsxMountName: 'mount', logGroupPrefix: `/aws/sagemaker/Clusters/hp-${id}` },
    namespaces: ['hyperpod-ns-team-a'],
    evidence: Object.fromEntries(backendCapabilities.map(name => [name, { status: 'verified', checkedAt: '2026-09-16T00:00:00Z', expiresAt: '2026-09-17T00:00:00Z', reference: `deployment/${id}/${name}` }])) };
}
