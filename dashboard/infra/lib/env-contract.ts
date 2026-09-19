/**
 * Mirror of dashboard/web/src/server/config.ts ENV_KEYS. Builds the container
 * environment from the outputs discovered on the sibling stacks. Keys with an
 * undefined value are omitted (the app treats "" and missing the same way).
 */
export interface DiscoveredOutputs {
  region: string;
  accountId: string;
  hyperPodEks?: Record<string, string>; // HyperPodEks-<acct>
  hyperPodSlurm?: Record<string, string>; // HyperPod-<acct>
  groot?: Record<string, string>; // GrootFinetune-<acct>
  isaacLab?: Record<string, string>; // IsaacLab-<Profile>-<acct>
}

export function buildEnv(d: DiscoveredOutputs, extra: Record<string, string | undefined>, authMode: 'alb' | 'cognito' = 'alb'): Record<string, string> {
  const e: Record<string, string | undefined> = {
    AWS_REGION: d.region,
    ACCOUNT_ID: d.accountId,
    // Kept at position 3 so the rendered container Environment array is byte-identical for https (parity gate).
    AUTH_MODE: authMode,
    WORKFLOW_CONTROLLER: '1',
    DEFAULT_NAMESPACE: 'rl',
    // HyperPod EKS
    EKS_CLUSTER_NAME: d.hyperPodEks?.EksClusterName,
    HYPERPOD_EKS_CLUSTER_NAME: d.hyperPodEks?.ClusterName,
    EKS_DATA_BUCKET: d.hyperPodEks?.S3BucketName,
    FSX_FILE_SYSTEM_ID: d.hyperPodEks?.FsxFileSystemId,
    FSX_DNS_NAME: d.hyperPodEks?.FsxDnsName,
    FSX_MOUNT_NAME: d.hyperPodEks?.FsxMountName,
    AMP_WORKSPACE_ID: d.hyperPodEks?.AmpWorkspaceId,
    // HyperPod Slurm
    HYPERPOD_SLURM_CLUSTER_NAME: d.hyperPodSlurm?.ClusterName,
    SLURM_DATA_BUCKET: d.hyperPodSlurm?.S3BucketName,
    SLURM_FSX_FILE_SYSTEM_ID: d.hyperPodSlurm?.FsxFileSystemId,
    // GR00T / SageMaker
    ARTIFACTS_BUCKET: d.groot?.BucketName,
    MLFLOW_TRACKING_SERVER_ARN: d.groot?.MlflowTrackingServerArn,
    MLFLOW_TRACKING_SERVER_NAME: d.groot?.MlflowTrackingServerName,
    SM_PIPELINE_NAME: d.groot ? d.groot.PipelineName ?? `groot-sm-finetuning-${d.accountId}` : undefined,
    SM_MODEL_PACKAGE_GROUP: d.groot ? `groot-sm-models-${d.accountId}` : undefined,
    SM_TRAINING_IMAGE_URI: d.groot?.TrainingRepositoryUri ? `${d.groot.TrainingRepositoryUri}:latest` : undefined,
    SM_ROLE_ARN: d.groot?.SageMakerRoleArn,
    // DCV workstation
    DCV_INSTANCE_ID: d.isaacLab?.InstanceId,
    DCV_SECRET_ARN: d.isaacLab?.SecretArn,
    DCV_URL: d.isaacLab?.DcvUrl,
    CODE_SERVER_URL: d.isaacLab?.CodeServerUrl,
    ...extra,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}
