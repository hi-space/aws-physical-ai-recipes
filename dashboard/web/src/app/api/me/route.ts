import { route } from '@/server/api';
import { config } from '@/server/config';
import { requestProject } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session, req }) => {
  const c = config();
  const project = await requestProject(req, session).catch(() => undefined);
  return {
    ...session,
    region: c.region,
    accountId: c.accountId,
    features: {
      eks: Boolean(c.eks), slurm: Boolean(c.slurm), amp: Boolean(c.eks?.ampWorkspaceId), mlflow: Boolean(c.groot?.mlflowTrackingServerArn),
      pipeline: Boolean(c.groot?.pipelineName), dcv: Boolean(c.dcv), fsx: Boolean(c.eks?.fsxFileSystemId), edge: Boolean(c.edge?.thingGroup), cognito: Boolean(c.cognitoUserPoolId),
      sessions: Boolean(c.gatewayBaseDomain),
    },
    clusters: { eks: c.eks?.hyperPodClusterName, slurm: c.slurm?.hyperPodClusterName, eksName: c.eks?.eksClusterName },
    buckets: { data: c.eks?.dataBucket, artifacts: c.groot?.artifactsBucket },
    defaultNamespace: project?.namespace ?? c.defaultNamespace,
    project: project ? { id: project.id, name: project.name, role: session.role === 'admin' ? 'project-admin' : project.members[session.subject ?? session.user] } : undefined,
  };
});
