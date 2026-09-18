# CodeBuild projects: cluster operations (RBAC/add-ons via infra/ops/apply_addons.py) and the
# project-scoped researcher source-image builder (mirror of constructs/operations.ts and
# constructs/source-build-project.ts).

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- operations (kubectl apply from inside the VPC)
resource "aws_cloudwatch_log_group" "operations" {
  count             = local.has_eks ? 1 : 0
  name              = "/aws/codebuild/${local.operations_project}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "operations" {
  count              = local.has_eks ? 1 : 0
  name               = "${local.prefix}-operations"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

data "aws_iam_policy_document" "operations" {
  count = local.has_eks ? 1 : 0
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.operations[0].arn}:*"]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.assets.arn}/${aws_s3_object.ops_source.key}"]
  }
  statement {
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]
  }
  statement {
    actions   = ["eks:DescribeCluster"]
    resources = ["arn:${local.partition}:eks:${var.region}:${local.account}:cluster/${local.eks_cluster_name}"]
  }
  # VPC-attached CodeBuild needs ENI management in the private subnets.
  statement {
    actions   = ["ec2:CreateNetworkInterface", "ec2:DescribeDhcpOptions", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:CreateNetworkInterfacePermission"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account}:network-interface/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:AuthorizedService"
      values   = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "operations" {
  count  = local.has_eks ? 1 : 0
  role   = aws_iam_role.operations[0].id
  policy = data.aws_iam_policy_document.operations[0].json
}

resource "aws_codebuild_project" "operations" {
  count         = local.has_eks ? 1 : 0
  name          = local.operations_project
  service_role  = aws_iam_role.operations[0].arn
  build_timeout = 20
  source {
    type     = "S3"
    location = "${aws_s3_bucket.assets.bucket}/${aws_s3_object.ops_source.key}"
    buildspec = jsonencode({
      version = "0.2"
      phases = {
        install = { commands = [
          "python -c \"import urllib.request,hashlib,pathlib,os; u='https://dl.k8s.io/release/v1.34.2/bin/linux/amd64/kubectl'; b=urllib.request.urlopen(u).read(); h=urllib.request.urlopen(u+'.sha256').read().decode().strip(); assert hashlib.sha256(b).hexdigest()==h; p=pathlib.Path('/usr/local/bin/kubectl'); p.write_bytes(b); p.chmod(0o755)\"",
        ] }
        build = { commands = ["python apply_addons.py --cluster \"$EKS_CLUSTER_NAME\" --region \"$AWS_REGION\""] }
      }
    })
  }
  artifacts {
    type = "NO_ARTIFACTS"
  }
  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false
    environment_variable {
      name  = "EKS_CLUSTER_NAME"
      value = local.eks_cluster_name
    }
  }
  vpc_config {
    vpc_id             = local.vpc_id
    subnets            = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.operations[0].name
    }
  }
  depends_on = [aws_iam_role_policy.operations]
}

# ---------------------------------------------------------------- researcher source-image builder
locals {
  source_build_name = "${local.prefix}-source-${var.source_build_project_id}"
  source_build_repo = "${local.prefix}/projects/${var.source_build_project_id}/source-images"
  source_buildspec  = jsondecode(file("${local.repo_root}/dashboard/web/src/server/services/source-buildspec.json")).text
  source_build_target = {
    id                   = var.source_build_project_id
    projectId            = var.source_build_project_id
    codeBuildProjectName = local.source_build_name
    sourceType           = "S3"
    snapshotLocation     = { bucket = aws_s3_bucket.assets.bucket, key = aws_s3_object.source_build_snapshot.key }
    serviceRoleArn       = aws_iam_role.source_build.arn
    builderImage         = "aws/codebuild/standard:7.0"
    outputRepositoryName = local.source_build_repo
    dockerfile           = "Dockerfile"
    context              = "."
    timeoutMinutes       = 20
    queuedTimeoutMinutes = 5
    computeType          = "BUILD_GENERAL1_SMALL"
  }
}

resource "aws_ecr_repository" "source_images" {
  name                 = local.source_build_repo
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
}

resource "aws_cloudwatch_log_group" "source_build" {
  name              = "/aws/codebuild/${local.source_build_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "source_build_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:codebuild:${var.region}:${local.account}:project/${local.source_build_name}"]
    }
  }
}

resource "aws_iam_role" "source_build" {
  name               = "${local.prefix}-source-build"
  assume_role_policy = data.aws_iam_policy_document.source_build_assume.json
}

data "aws_iam_policy_document" "source_build" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.assets.arn}/${aws_s3_object.source_build_snapshot.key}"]
  }
  statement {
    actions   = ["s3:GetBucketLocation", "s3:GetBucketAcl"]
    resources = [aws_s3_bucket.assets.arn]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:DescribeRepositories"]
    resources = [aws_ecr_repository.source_images.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.source_build.arn}:*"]
  }
}

resource "aws_iam_role_policy" "source_build" {
  role   = aws_iam_role.source_build.id
  policy = data.aws_iam_policy_document.source_build.json
}

resource "aws_codebuild_project" "source_build" {
  name                   = local.source_build_name
  description            = "Project-scoped source image builder for ${var.source_build_project_id}"
  service_role           = aws_iam_role.source_build.arn
  build_timeout          = 20
  queued_timeout         = 5
  concurrent_build_limit = 1
  source {
    type      = "S3"
    location  = "${aws_s3_bucket.assets.bucket}/${aws_s3_object.source_build_snapshot.key}"
    buildspec = local.source_buildspec
  }
  artifacts {
    type = "NO_ARTIFACTS"
  }
  cache {
    type = "NO_CACHE"
  }
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }
  logs_config {
    cloudwatch_logs {
      status     = "ENABLED"
      group_name = aws_cloudwatch_log_group.source_build.name
    }
    s3_logs {
      status = "DISABLED"
    }
  }
  tags = {
    "pai:project" = var.source_build_project_id
    "pai:purpose" = "source-image-build"
  }
  depends_on = [aws_iam_role_policy.source_build]
}
