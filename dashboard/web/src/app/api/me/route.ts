import { route } from '@/server/api';
import { config } from '@/server/config';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session }) => {
  const c = config();
  return {
    ...session,
    region: c.region,
    accountId: c.accountId,
    features: {
      eks: Boolean(c.eks), slurm: Boolean(c.slurm), amp: Boolean(c.eks?.ampWorkspaceId), mlflow: Boolean(c.groot?.mlflowTrackingServerArn),
      pipeline: Boolean(c.groot?.pipelineName), dcv: Boolean(c.dcv), fsx: Boolean(c.eks?.fsxFileSystemId), edge: Boolean(c.edge?.thingGroup), cognito: Boolean(c.cognitoUserPoolId),
    },
    clusters: { eks: c.eks?.hyperPodClusterName, slurm: c.slurm?.hyperPodClusterName, eksName: c.eks?.eksClusterName },
    buckets: { data: c.eks?.dataBucket, artifacts: c.groot?.artifactsBucket },
    defaultNamespace: c.defaultNamespace,
  };
});
