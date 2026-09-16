/**
 * Single source of truth for the environment contract between the CDK stack
 * (dashboard/infra/lib/env-contract.ts) and the application.
 *
 * Every value that points at infrastructure is discovered by CDK from the
 * sibling stacks' CloudFormation outputs and injected as an env var. Optional
 * values are `undefined` when the corresponding stack is not deployed, and the
 * UI degrades gracefully (the page shows "not configured" instead of failing).
 */

export type AuthMode = 'alb' | 'dev';

export interface DashboardConfig {
  region: string;
  accountId: string;
  authMode: AuthMode;
  controllerEnabled: boolean;
  defaultNamespace: string;
  tableName: string;
  snsTopicArn?: string;
  cognitoUserPoolId?: string;
  albArn?: string;
  /** HyperPod EKS orchestrator */
  eks?: {
    eksClusterName: string;
    hyperPodClusterName: string;
    dataBucket: string;
    fsxFileSystemId?: string;
    fsxDnsName?: string;
    fsxMountName?: string;
    ampWorkspaceId?: string;
    logGroupPrefix: string; // /aws/sagemaker/Clusters/<name>
  };
  /** HyperPod Slurm cluster (managed only, no job submission) */
  slurm?: {
    hyperPodClusterName: string;
    dataBucket?: string;
    fsxFileSystemId?: string;
  };
  /** GR00T fine-tune stack */
  groot?: {
    artifactsBucket: string;
    mlflowTrackingServerArn?: string;
    mlflowTrackingServerName?: string;
    pipelineName?: string;
    modelPackageGroup?: string;
    trainingImageUri?: string;
    sageMakerRoleArn?: string;
    trainingLogGroup?: string;
  };
  /** IsaacLab DCV workstation */
  dcv?: {
    instanceId: string;
    secretArn?: string;
    dcvUrl?: string;
    codeServerUrl?: string;
  };
  /** Greengrass edge */
  edge?: {
    thingGroup?: string;
    inferenceComponent?: string;
  };
}

export const ENV_KEYS = [
  'AWS_REGION',
  'ACCOUNT_ID',
  'AUTH_MODE',
  'WORKFLOW_CONTROLLER',
  'DEFAULT_NAMESPACE',
  'TABLE_NAME',
  'SNS_TOPIC_ARN',
  'COGNITO_USER_POOL_ID',
  'ALB_ARN',
  'EKS_CLUSTER_NAME',
  'HYPERPOD_EKS_CLUSTER_NAME',
  'EKS_DATA_BUCKET',
  'FSX_FILE_SYSTEM_ID',
  'FSX_DNS_NAME',
  'FSX_MOUNT_NAME',
  'AMP_WORKSPACE_ID',
  'HYPERPOD_SLURM_CLUSTER_NAME',
  'SLURM_DATA_BUCKET',
  'SLURM_FSX_FILE_SYSTEM_ID',
  'ARTIFACTS_BUCKET',
  'MLFLOW_TRACKING_SERVER_ARN',
  'MLFLOW_TRACKING_SERVER_NAME',
  'SM_PIPELINE_NAME',
  'SM_MODEL_PACKAGE_GROUP',
  'SM_TRAINING_IMAGE_URI',
  'SM_ROLE_ARN',
  'SM_TRAINING_LOG_GROUP',
  'DCV_INSTANCE_ID',
  'DCV_SECRET_ARN',
  'DCV_URL',
  'CODE_SERVER_URL',
  'GREENGRASS_THING_GROUP',
  'GREENGRASS_INFERENCE_COMPONENT',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

function opt(env: NodeJS.ProcessEnv, key: EnvKey): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const authMode = (opt(env, 'AUTH_MODE') ?? 'alb') as AuthMode;
  if (authMode !== 'alb' && authMode !== 'dev') throw new ConfigError(`AUTH_MODE must be alb|dev, got ${authMode}`);
  const region = opt(env, 'AWS_REGION') ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const accountId = opt(env, 'ACCOUNT_ID') ?? '';
  const tableName = opt(env, 'TABLE_NAME');
  if (!tableName && authMode === 'alb') throw new ConfigError('TABLE_NAME is required');

  const eksName = opt(env, 'EKS_CLUSTER_NAME');
  const hpEks = opt(env, 'HYPERPOD_EKS_CLUSTER_NAME');
  const eksBucket = opt(env, 'EKS_DATA_BUCKET');
  const eks: DashboardConfig['eks'] =
    eksName && hpEks && eksBucket
      ? {
          eksClusterName: eksName,
          hyperPodClusterName: hpEks,
          dataBucket: eksBucket,
          fsxFileSystemId: opt(env, 'FSX_FILE_SYSTEM_ID'),
          fsxDnsName: opt(env, 'FSX_DNS_NAME'),
          fsxMountName: opt(env, 'FSX_MOUNT_NAME'),
          ampWorkspaceId: opt(env, 'AMP_WORKSPACE_ID'),
          logGroupPrefix: `/aws/sagemaker/Clusters/${hpEks}`,
        }
      : undefined;

  const slurmName = opt(env, 'HYPERPOD_SLURM_CLUSTER_NAME');
  const slurm: DashboardConfig['slurm'] = slurmName
    ? { hyperPodClusterName: slurmName, dataBucket: opt(env, 'SLURM_DATA_BUCKET'), fsxFileSystemId: opt(env, 'SLURM_FSX_FILE_SYSTEM_ID') }
    : undefined;

  const artifactsBucket = opt(env, 'ARTIFACTS_BUCKET');
  const groot: DashboardConfig['groot'] = artifactsBucket
    ? {
        artifactsBucket,
        mlflowTrackingServerArn: opt(env, 'MLFLOW_TRACKING_SERVER_ARN'),
        mlflowTrackingServerName: opt(env, 'MLFLOW_TRACKING_SERVER_NAME'),
        pipelineName: opt(env, 'SM_PIPELINE_NAME'),
        modelPackageGroup: opt(env, 'SM_MODEL_PACKAGE_GROUP'),
        trainingImageUri: opt(env, 'SM_TRAINING_IMAGE_URI'),
        sageMakerRoleArn: opt(env, 'SM_ROLE_ARN'),
        trainingLogGroup: opt(env, 'SM_TRAINING_LOG_GROUP') ?? '/aws/sagemaker/TrainingJobs',
      }
    : undefined;

  const dcvInstance = opt(env, 'DCV_INSTANCE_ID');
  const dcv: DashboardConfig['dcv'] = dcvInstance
    ? { instanceId: dcvInstance, secretArn: opt(env, 'DCV_SECRET_ARN'), dcvUrl: opt(env, 'DCV_URL'), codeServerUrl: opt(env, 'CODE_SERVER_URL') }
    : undefined;

  const edge: DashboardConfig['edge'] = {
    thingGroup: opt(env, 'GREENGRASS_THING_GROUP') ?? (accountId ? `groot-${accountId}-group` : undefined),
    inferenceComponent: opt(env, 'GREENGRASS_INFERENCE_COMPONENT') ?? (accountId ? `com.workshop.${accountId}.inference` : undefined),
  };

  return {
    region,
    accountId,
    authMode,
    controllerEnabled: (opt(env, 'WORKFLOW_CONTROLLER') ?? '0') === '1',
    defaultNamespace: opt(env, 'DEFAULT_NAMESPACE') ?? 'rl',
    tableName: tableName ?? 'physical-ai-dashboard-dev',
    snsTopicArn: opt(env, 'SNS_TOPIC_ARN'),
    cognitoUserPoolId: opt(env, 'COGNITO_USER_POOL_ID'),
    albArn: opt(env, 'ALB_ARN'),
    eks,
    slurm,
    groot,
    dcv,
    edge,
  };
}

let cached: DashboardConfig | undefined;
/** Process-wide cached config (env does not change at runtime). */
export function config(): DashboardConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
export function resetConfigForTests(): void {
  cached = undefined;
}

/** Well-known bucket prefixes used by the sibling stacks (FSx DRA mapping). */
export const FSX_DRA = [
  { fsxPath: '/fsx/datasets', s3Prefix: 'datasets/' },
  { fsxPath: '/fsx/checkpoints', s3Prefix: 'checkpoints/' },
  { fsxPath: '/fsx/enroot', s3Prefix: 'enroot/' },
] as const;

/** Map an FSx path to its S3 mirror on the EKS data bucket, or undefined when the path is not exported. */
export function fsxPathToS3(fsxPath: string, bucket: string): string | undefined {
  for (const m of FSX_DRA) {
    if (fsxPath === m.fsxPath || fsxPath.startsWith(m.fsxPath + '/')) {
      const rest = fsxPath.slice(m.fsxPath.length).replace(/^\//, '');
      return `s3://${bucket}/${m.s3Prefix}${rest}`;
    }
  }
  return undefined;
}
