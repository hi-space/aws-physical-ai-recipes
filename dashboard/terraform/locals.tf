# Container environment contract. Mirrors infra/lib/env-contract.ts (buildEnv) plus the additions in
# infra/lib/dashboard-stack.ts and constructs/service.ts. Keys with empty values are dropped, exactly
# like the CDK helper does; the application treats "" and unset identically.

locals {
  cognito_domain_prefix = var.cognito_domain_prefix != "" ? var.cognito_domain_prefix : "physical-ai-${local.account}"
  cognito_domain        = "${local.cognito_domain_prefix}.auth.${var.region}.amazoncognito.com"
  admin_email           = var.admin_email != "" ? var.admin_email : (local.has_domain ? "admin@${data.aws_route53_zone.zone[0].name}" : "admin@${local.account}.invalid")
  cloudmap_namespace    = "${local.prefix}.internal"
  runtime_api_url       = "http://controller.${local.cloudmap_namespace}:3001"
  operations_project    = "${local.prefix}-operations"
  # Match the final environment's override precedence so IAM uses the same name.
  groot_pipeline_name = local.has_groot ? lookup(var.extra_environment, "SM_PIPELINE_NAME",
  lookup(local.groot_out, "PipelineName", "groot-sm-finetuning-${local.account}")) : ""

  build_projects = compact([local.has_eks ? local.operations_project : "", lookup(local.groot_out, "SmTrainingBuildProjectName", ""), lookup(local.groot_out, "RuntimeCodeBuildProjectName", "")])

  discovered_env = {
    AWS_REGION          = var.region
    ACCOUNT_ID          = local.account
    AUTH_MODE           = "alb"
    WORKFLOW_CONTROLLER = "1"
    DEFAULT_NAMESPACE   = "rl"
    # HyperPod EKS
    EKS_CLUSTER_NAME          = local.eks_cluster_name
    HYPERPOD_EKS_CLUSTER_NAME = lookup(local.eks_out, "ClusterName", "")
    EKS_DATA_BUCKET           = lookup(local.eks_out, "S3BucketName", "")
    FSX_FILE_SYSTEM_ID        = lookup(local.eks_out, "FsxFileSystemId", "")
    FSX_DNS_NAME              = lookup(local.eks_out, "FsxDnsName", "")
    FSX_MOUNT_NAME            = lookup(local.eks_out, "FsxMountName", "")
    AMP_WORKSPACE_ID          = lookup(local.eks_out, "AmpWorkspaceId", "")
    # HyperPod Slurm
    HYPERPOD_SLURM_CLUSTER_NAME = lookup(local.slurm_out, "ClusterName", "")
    SLURM_DATA_BUCKET           = lookup(local.slurm_out, "S3BucketName", "")
    SLURM_FSX_FILE_SYSTEM_ID    = lookup(local.slurm_out, "FsxFileSystemId", "")
    # GR00T / SageMaker
    ARTIFACTS_BUCKET            = lookup(local.groot_out, "BucketName", "")
    MLFLOW_TRACKING_SERVER_ARN  = lookup(local.groot_out, "MlflowTrackingServerArn", "")
    MLFLOW_TRACKING_SERVER_NAME = lookup(local.groot_out, "MlflowTrackingServerName", "")
    SM_PIPELINE_NAME            = local.groot_pipeline_name
    SM_MODEL_PACKAGE_GROUP      = local.has_groot ? "groot-sm-models-${local.account}" : ""
    SM_TRAINING_IMAGE_URI       = lookup(local.groot_out, "TrainingRepositoryUri", "") != "" ? "${local.groot_out["TrainingRepositoryUri"]}:latest" : ""
    SM_ROLE_ARN                 = lookup(local.groot_out, "SageMakerRoleArn", "")
    # DCV workstation
    DCV_INSTANCE_ID = lookup(local.isaac_out, "InstanceId", "")
    DCV_SECRET_ARN  = lookup(local.isaac_out, "SecretArn", "")
    DCV_URL         = lookup(local.isaac_out, "DcvUrl", "")
    CODE_SERVER_URL = lookup(local.isaac_out, "CodeServerUrl", "")
    # Edge
    GREENGRASS_THING_GROUP         = "groot-${local.account}-group"
    GREENGRASS_INFERENCE_COMPONENT = "com.workshop.${local.account}.inference"
  }

  stack_env = {
    TABLE_NAME                 = aws_dynamodb_table.store.name
    SNS_TOPIC_ARN              = aws_sns_topic.notifications.arn
    IMAGE_PROFILES_ENFORCED    = "1"
    LOG_ARCHIVE_ENABLED        = "1"
    SOURCE_BUILD_TARGETS_JSON  = jsonencode([local.source_build_target])
    BACKEND_HOME_VPC_ID        = local.vpc_id
    EKS_BACKENDS_JSON          = jsonencode(var.eks_backends)
    WORKFLOW_STATE_MACHINE_ARN = aws_sfn_state_machine.workflow.arn
    WORKFLOW_QUEUE_URL         = aws_sqs_queue.requests.url
    WORKFLOW_CALLBACKS_TABLE   = aws_dynamodb_table.callbacks.name
    DASHBOARD_ARTIFACT_BUCKET  = aws_s3_bucket.artifacts.bucket
    TASK_RUNTIME_IMAGE         = local.image_uris["runtime"]
    RUNTIME_API_URL            = local.runtime_api_url
    GATEWAY_BASE_DOMAIN        = local.has_domain ? "apps.${local.domain}" : ""
    DCV_SSO_SECRET_ARN         = local.has_dcv ? aws_secretsmanager_secret.dcv_sso[0].arn : ""
    DCV_AGENT_ASSET_URI        = local.has_dcv ? "s3://${aws_s3_bucket.assets.bucket}/${aws_s3_object.dcv_agent[0].key}" : ""
    BUILD_PROJECTS             = join(",", local.build_projects)
  }

  base_env = { for k, v in merge(local.discovered_env, local.workload_image_env, local.stack_env, var.extra_environment) : k => v if v != "" }

  # Per-service additions from constructs/service.ts.
  web_env = merge(local.base_env, {
    ALB_ARN              = aws_lb.alb.arn
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.pool.id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.alb.id
    COGNITO_DOMAIN       = local.cognito_domain
    DASHBOARD_ORIGIN     = local.origin
    WORKFLOW_CONTROLLER  = "0"
    PORT                 = "3000"
    HOSTNAME             = "0.0.0.0"
  })
  controller_env = merge(local.base_env, {
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.pool.id
    WORKFLOW_CONTROLLER  = "0"
    AUTH_MODE            = "alb"
    NODE_ENV             = "production"
  })
  gateway_env = merge(local.base_env, {
    AUTH_MODE            = "alb"
    WORKFLOW_CONTROLLER  = "0"
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.pool.id
    DASHBOARD_ORIGIN     = local.origin
    GATEWAY_BASE_DOMAIN  = local.has_domain ? "apps.${local.domain}" : ""
    GATEWAY_ASSET_DIR    = "/app/services/gateway-assets"
  })
}
