# IAM for the three Fargate services (task roles + execution roles). Statements mirror
# infra/lib/dashboard-stack.ts and constructs/source-build-project.ts (grantControlPlane).

locals {
  partition          = data.aws_partition.current.partition
  ssm_parameter_arns = [for p in ["groot", "physical-ai", "pai"] : "arn:${local.partition}:ssm:${var.region}:${local.account}:parameter/${p}/*"]
  codebuild_project_arns = flatten([for name in local.build_projects : [
    "arn:${local.partition}:codebuild:${var.region}:${local.account}:project/${name}",
    "arn:${local.partition}:codebuild:${var.region}:${local.account}:build/${name}:*",
  ]])
  groot_pipeline_arn = "arn:${local.partition}:sagemaker:${var.region}:${local.account}:pipeline/${lookup(local.groot_out, "PipelineName", "groot-sm-finetuning-${local.account}")}"
  groot_packages_arn = "arn:${local.partition}:sagemaker:${var.region}:${local.account}:model-package/groot-sm-models-${local.account}/*"
  dcv_instance_arn   = local.has_dcv ? "arn:${local.partition}:ec2:${var.region}:${local.account}:instance/${local.isaac_out["InstanceId"]}" : ""
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- execution roles (pull images, ship logs, read secrets)
resource "aws_iam_role" "execution" {
  for_each           = toset(["web", "controller", "gateway"])
  name               = "${local.prefix}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "controller_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.runtime_signing.arn]
  }
}

resource "aws_iam_role_policy" "controller_execution_secrets" {
  role   = aws_iam_role.execution["controller"].id
  policy = data.aws_iam_policy_document.controller_execution_secrets.json
}

# ---------------------------------------------------------------- shared statement fragments
data "aws_iam_policy_document" "source_build_control_plane" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.assets.arn}/${aws_s3_object.source_build_snapshot.key}"]
  }
  statement {
    actions   = ["codebuild:BatchGetProjects", "codebuild:ListBuildsForProject", "codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:StopBuild"]
    resources = [aws_codebuild_project.source_build.arn]
  }
  statement {
    actions   = ["ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.source_images.arn]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.source_build.arn}:*"]
  }
}

data "aws_iam_policy_document" "table_read_write" {
  statement {
    actions   = ["dynamodb:BatchGetItem", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"]
    resources = [aws_dynamodb_table.store.arn, "${aws_dynamodb_table.store.arn}/index/*"]
  }
}

data "aws_iam_policy_document" "artifacts_read_write" {
  statement {
    actions   = ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject", "s3:PutObjectLegalHold", "s3:PutObjectRetention", "s3:PutObjectTagging", "s3:PutObjectVersionTagging", "s3:Abort*"]
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
  }
}

data "aws_iam_policy_document" "hyperpod_capacity" {
  count = lookup(local.eks_out, "ClusterArn", "") != "" ? 1 : 0
  statement {
    sid       = "ReviewedHyperPodCapacity"
    actions   = ["sagemaker:DescribeCluster", "sagemaker:ListClusterNodes", "sagemaker:UpdateCluster", "sagemaker:BatchDeleteClusterNodes"]
    resources = [local.eks_out["ClusterArn"]]
  }
}

data "aws_iam_policy_document" "groot_evidence" {
  count = local.has_groot ? 1 : 0
  statement {
    sid = "PipelineArchiveEvidence"
    actions = ["sagemaker:DescribePipeline", "sagemaker:DescribePipelineExecution", "sagemaker:DescribePipelineDefinitionForExecution",
    "sagemaker:ListPipelineExecutions", "sagemaker:ListPipelineExecutionSteps", "sagemaker:ListPipelineParametersForExecution"]
    resources = [local.groot_pipeline_arn, "${local.groot_pipeline_arn}/execution/*"]
  }
  statement {
    sid       = "PipelineJobEvidence"
    actions   = ["sagemaker:DescribeTrainingJob", "sagemaker:DescribeProcessingJob"]
    resources = ["arn:${local.partition}:sagemaker:${var.region}:${local.account}:training-job/*", "arn:${local.partition}:sagemaker:${var.region}:${local.account}:processing-job/*"]
  }
  statement {
    sid       = "ConfiguredModelPackageEvidence"
    actions   = ["sagemaker:DescribeModelPackage"]
    resources = [local.groot_packages_arn]
  }
  dynamic "statement" {
    for_each = lookup(local.groot_out, "SageMakerRoleArn", "") != "" ? [1] : []
    content {
      sid       = "PassRoleToSageMakerPipeline"
      actions   = ["iam:PassRole"]
      resources = [local.groot_out["SageMakerRoleArn"]]
      condition {
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["sagemaker.amazonaws.com"]
      }
    }
  }
}

data "aws_iam_policy_document" "cognito_user_read" {
  statement {
    actions   = ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"]
    resources = [aws_cognito_user_pool.pool.arn]
  }
}

data "aws_iam_policy_document" "ssm_secure_parameters" {
  statement {
    sid       = "SsmCredentialParameters"
    actions   = ["ssm:GetParameter"]
    resources = local.ssm_parameter_arns
  }
  statement {
    sid       = "KmsForSecureStrings"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- web (browser request handling)
resource "aws_iam_role" "web" {
  name               = "${local.prefix}-task"
  description        = "Physical AI Dashboard application role (EKS access entry principal)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "web" {
  statement {
    actions   = ["codebuild:BatchGetProjects", "codebuild:ListBuildsForProject", "codebuild:StartBuild", "codebuild:BatchGetBuilds"]
    resources = length(local.codebuild_project_arns) > 0 ? local.codebuild_project_arns : ["arn:${local.partition}:codebuild:${var.region}:${local.account}:project/${local.prefix}-none"]
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [aws_secretsmanager_secret.dcv_sso[0].arn]
    }
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.notifications.arn]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.workflow.arn]
  }
  statement {
    sid = "HyperPodAndSageMaker"
    actions = ["sagemaker:ListClusters", "sagemaker:DescribeCluster", "sagemaker:ListClusterNodes", "sagemaker:DescribeClusterNode", "sagemaker:UpdateCluster",
      "sagemaker:ListClusterEvents", "sagemaker:DescribeClusterEvent", "sagemaker:ListComputeQuotas", "sagemaker:DescribeComputeQuota", "sagemaker:CreateComputeQuota",
      "sagemaker:DeleteComputeQuota", "sagemaker:ListClusterSchedulerConfigs", "sagemaker:DescribeClusterSchedulerConfig", "sagemaker:CreateClusterSchedulerConfig",
      "sagemaker:DeleteClusterSchedulerConfig", "sagemaker:DescribePipeline", "sagemaker:ListPipelineExecutions", "sagemaker:StartPipelineExecution",
      "sagemaker:StopPipelineExecution", "sagemaker:DescribePipelineExecution", "sagemaker:ListPipelineExecutionSteps", "sagemaker:ListPipelineParametersForExecution",
      "sagemaker:ListTrainingJobs", "sagemaker:DescribeTrainingJob", "sagemaker:ListModelPackages", "sagemaker:DescribeMlflowTrackingServer",
    "sagemaker:CreatePresignedMlflowTrackingServerUrl", "sagemaker:AddTags"]
    resources = ["*"]
  }
  statement {
    sid       = "MlflowRest"
    actions   = ["sagemaker-mlflow:*"]
    resources = ["arn:${local.partition}:sagemaker:${var.region}:${local.account}:mlflow-tracking-server/*"]
  }
  dynamic "statement" {
    for_each = local.has_groot ? [1] : []
    content {
      sid       = "ExplicitVerifiedModelApproval"
      actions   = ["sagemaker:UpdateModelPackage"]
      resources = [local.groot_packages_arn]
    }
  }
  statement {
    sid       = "Eks"
    actions   = ["eks:DescribeCluster", "eks:ListAddons", "eks:DescribeAddon", "eks:ListClusters"]
    resources = ["*"]
  }
  statement {
    sid       = "Sts"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
  statement {
    sid       = "Amp"
    actions   = ["aps:QueryMetrics", "aps:GetLabels", "aps:GetSeries", "aps:GetMetricMetadata", "aps:DescribeWorkspace"]
    resources = ["*"]
  }
  statement {
    sid       = "Fsx"
    actions   = ["fsx:DescribeFileSystems", "fsx:DescribeDataRepositoryAssociations", "fsx:DescribeDataRepositoryTasks", "fsx:CreateDataRepositoryTask", "fsx:TagResource"]
    resources = ["*"]
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      sid       = "S3Buckets"
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = [for b in local.buckets : "arn:${local.partition}:s3:::${b}"]
    }
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      sid       = "S3Objects"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
      resources = [for b in local.buckets : "arn:${local.partition}:s3:::${b}/*"]
    }
  }
  statement {
    sid       = "CloudWatchLogsRead"
    actions   = ["logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartLiveTail"]
    resources = ["*"]
  }
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"]
    resources = ["*"]
  }
  statement {
    sid       = "ImageProfileInspection"
    actions   = ["ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/*"]
  }
  statement {
    sid       = "ImageProfileDiscovery"
    actions   = ["ecr:GetAuthorizationToken", "ec2:DescribeInstanceTypes"]
    resources = ["*"]
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      sid       = "DcvInstanceControl"
      actions   = ["ec2:StartInstances", "ec2:StopInstances"]
      resources = [local.dcv_instance_arn]
    }
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["ssm:SendCommand"]
      resources = [local.dcv_instance_arn, "arn:${local.partition}:ssm:${var.region}::document/AWS-RunShellScript"]
    }
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["ssm:GetCommandInvocation"]
      resources = ["*"]
    }
  }
  dynamic "statement" {
    for_each = lookup(local.isaac_out, "SecretArn", "") != "" ? [1] : []
    content {
      sid       = "DcvSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [local.isaac_out["SecretArn"]]
    }
  }
  statement {
    sid = "Greengrass"
    actions = ["greengrass:ListCoreDevices", "greengrass:ListComponents", "greengrass:ListDeployments", "greengrass:ListEffectiveDeployments",
      "greengrass:ListInstalledComponents", "greengrass:CreateDeployment", "greengrass:GetDeployment", "greengrass:GetCoreDevice", "greengrass:GetComponent",
    "greengrass:DescribeComponent", "greengrass:ResolveComponentCandidates", "iot:DescribeThingGroup", "iot:ListThingsInThingGroup", "iot:DescribeJob", "iot:CreateJob", "iot:DescribeThing"]
    resources = ["*"]
  }
  statement {
    sid = "CognitoUserAdmin"
    actions = ["cognito-idp:ListUsers", "cognito-idp:ListGroups", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser",
    "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup"]
    resources = [aws_cognito_user_pool.pool.arn]
  }
  statement {
    sid       = "CostExplorer"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }
  statement {
    sid       = "ProjectCredentialManagement"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter"]
    resources = ["arn:${local.partition}:ssm:${var.region}:${local.account}:parameter/physical-ai/projects/*"]
  }
  statement {
    sid       = "ProjectCredentialEncryption"
    actions   = ["kms:Encrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "web" {
  for_each = merge({
    main         = data.aws_iam_policy_document.web.json
    table        = data.aws_iam_policy_document.table_read_write.json
    artifacts    = data.aws_iam_policy_document.artifacts_read_write.json
    source-build = data.aws_iam_policy_document.source_build_control_plane.json
    ssm          = data.aws_iam_policy_document.ssm_secure_parameters.json
    }, lookup(local.eks_out, "ClusterArn", "") != "" ? { hyperpod = data.aws_iam_policy_document.hyperpod_capacity[0].json } : {},
  local.has_groot ? { groot = data.aws_iam_policy_document.groot_evidence[0].json } : {})
  name   = each.key
  role   = aws_iam_role.web.id
  policy = each.value
}

# ---------------------------------------------------------------- controller (workflow worker)
resource "aws_iam_role" "controller" {
  name               = "${local.prefix}-controller"
  description        = "Physical AI workflow controller; separate from browser request handling"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "controller" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.notifications.arn]
  }
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.requests.arn]
  }
  statement {
    actions   = ["dynamodb:BatchGetItem", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"]
    resources = [aws_dynamodb_table.callbacks.arn]
  }
  statement {
    sid       = "CheckpointMultipartDiscovery"
    actions   = ["s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
  statement {
    sid       = "CheckpointMultipartLifecycle"
    actions   = ["s3:ListMultipartUploadParts", "s3:AbortMultipartUpload", "s3:GetObjectVersion", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.artifacts.arn}/projects/*"]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.workflow.arn]
  }
  statement {
    actions   = ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"]
    resources = ["*"]
  }
  statement {
    actions   = ["states:DescribeExecution"]
    resources = ["arn:${local.partition}:states:${var.region}:${local.account}:execution:${aws_sfn_state_machine.workflow.name}:*"]
  }
  statement {
    actions   = ["eks:DescribeCluster", "sts:GetCallerIdentity", "fsx:CreateDataRepositoryTask", "fsx:DescribeDataRepositoryTasks", "fsx:DescribeDataRepositoryAssociations"]
    resources = ["*"]
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = [for b in local.buckets : "arn:${local.partition}:s3:::${b}"]
    }
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = [for b in local.buckets : "arn:${local.partition}:s3:::${b}/*"]
    }
  }
  dynamic "statement" {
    for_each = lookup(local.groot_out, "MlflowTrackingServerArn", "") != "" ? [1] : []
    content {
      actions   = ["sagemaker:DescribeMlflowTrackingServer", "sagemaker-mlflow:*"]
      resources = [local.groot_out["MlflowTrackingServerArn"]]
    }
  }
  dynamic "statement" {
    for_each = lookup(local.groot_out, "BucketName", "") != "" ? [1] : []
    content {
      actions   = ["s3:PutObject"]
      resources = ["arn:${local.partition}:s3:::${local.groot_out["BucketName"]}/mlflow-artifacts/*"]
    }
  }
  dynamic "statement" {
    for_each = local.has_groot ? [1] : []
    content {
      actions   = ["sagemaker:StartPipelineExecution"]
      resources = [local.groot_pipeline_arn]
    }
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["ssm:GetCommandInvocation"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "controller" {
  for_each = merge({
    main         = data.aws_iam_policy_document.controller.json
    table        = data.aws_iam_policy_document.table_read_write.json
    artifacts    = data.aws_iam_policy_document.artifacts_read_write.json
    source-build = data.aws_iam_policy_document.source_build_control_plane.json
    ssm          = data.aws_iam_policy_document.ssm_secure_parameters.json
    cognito      = data.aws_iam_policy_document.cognito_user_read.json
    }, lookup(local.eks_out, "ClusterArn", "") != "" ? { hyperpod = data.aws_iam_policy_document.hyperpod_capacity[0].json } : {},
  local.has_groot ? { groot = data.aws_iam_policy_document.groot_evidence[0].json } : {})
  name   = each.key
  role   = aws_iam_role.controller.id
  policy = each.value
}

# ---------------------------------------------------------------- gateway (authenticated session transport)
resource "aws_iam_role" "gateway" {
  name               = "${local.prefix}-gateway"
  description        = "Physical AI authenticated session transport"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "gateway" {
  statement {
    actions   = ["eks:DescribeCluster", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["ssm:StartSession"]
      resources = [local.dcv_instance_arn, "arn:${local.partition}:ssm:${var.region}::document/AWS-StartPortForwardingSession"]
    }
  }
  dynamic "statement" {
    for_each = local.has_dcv ? [1] : []
    content {
      actions   = ["ssm:TerminateSession", "ssmmessages:OpenDataChannel"]
      resources = ["arn:${local.partition}:ssm:${var.region}:${local.account}:session/*"]
    }
  }
}

resource "aws_iam_role_policy" "gateway" {
  for_each = {
    main    = data.aws_iam_policy_document.gateway.json
    table   = data.aws_iam_policy_document.table_read_write.json
    cognito = data.aws_iam_policy_document.cognito_user_read.json
  }
  name   = each.key
  role   = aws_iam_role.gateway.id
  policy = each.value
}
