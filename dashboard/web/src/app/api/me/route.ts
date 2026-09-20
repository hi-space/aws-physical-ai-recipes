import { route } from '@/server/api';
import { config } from '@/server/config';
import { memberRole, requestProject } from '@/server/auth/projects';
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
      sessions: Boolean(c.gatewayBaseDomain || (c.gatewayMode === 'path' && c.gatewayPublicOrigin)),
    },
    gateway: c.gatewayMode === 'path' ? { mode: 'path' as const, origin: c.gatewayPublicOrigin } : { mode: 'host' as const },
    clusters: { eks: c.eks?.hyperPodClusterName, slurm: c.slurm?.hyperPodClusterName, eksName: c.eks?.eksClusterName },
    buckets: { data: c.eks?.dataBucket, artifacts: c.groot?.artifactsBucket },
    // Identifiers of the AWS resources behind each page, straight from the deployment contract (config.ts). No status
    // here: pages fetch live state from their own routes; /api/architecture describes each resource.
    resources: {
      hyperPodEks: c.eks ? { clusterName: c.eks.hyperPodClusterName, eksClusterName: c.eks.eksClusterName, logGroupPrefix: c.eks.logGroupPrefix } : undefined,
      hyperPodSlurm: c.slurm ? { clusterName: c.slurm.hyperPodClusterName, dataBucket: c.slurm.dataBucket, fsxFileSystemId: c.slurm.fsxFileSystemId } : undefined,
      fsx: c.eks?.fsxFileSystemId ? { fileSystemId: c.eks.fsxFileSystemId, dnsName: c.eks.fsxDnsName, mountName: c.eks.fsxMountName } : undefined,
      dataBucket: c.eks?.dataBucket,
      artifactsBucket: c.groot?.artifactsBucket,
      amp: c.eks?.ampWorkspaceId ? { workspaceId: c.eks.ampWorkspaceId } : undefined,
      mlflow: c.groot?.mlflowTrackingServerArn ? { trackingServerArn: c.groot.mlflowTrackingServerArn, trackingServerName: c.groot.mlflowTrackingServerName } : undefined,
      pipeline: c.groot?.pipelineName ? { name: c.groot.pipelineName, roleArn: c.groot.sageMakerRoleArn, modelPackageGroup: c.groot.modelPackageGroup, trainingLogGroup: c.groot.trainingLogGroup, trainingImageUri: c.groot.trainingImageUri } : undefined,
      dcv: c.dcv ? { instanceId: c.dcv.instanceId } : undefined,
      edge: c.edge?.thingGroup ? { thingGroup: c.edge.thingGroup, inferenceComponent: c.edge.inferenceComponent } : undefined,
      cognito: c.cognitoUserPoolId ? { userPoolId: c.cognitoUserPoolId } : undefined,
      table: c.tableName,
      workflowServiceAccount: c.workflowServiceAccount,
    },
    defaultNamespace: project?.namespace ?? c.defaultNamespace,
    project: project ? { id: project.id, name: project.name, role: memberRole(session, project) } : undefined,
  };
});
