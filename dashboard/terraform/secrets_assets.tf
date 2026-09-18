# Signing secrets and uploaded deployment assets (CDK: Secret + s3Assets.Asset).

resource "random_password" "runtime_signing" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "runtime_signing" {
  name                    = "${local.prefix}/runtime-signing"
  description             = "HMAC key for workload runtime capability tokens"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "runtime_signing" {
  secret_id     = aws_secretsmanager_secret.runtime_signing.id
  secret_string = jsonencode({ key = random_password.runtime_signing.result })
}

resource "random_password" "dcv_sso" {
  count   = local.has_dcv ? 1 : 0
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "dcv_sso" {
  count                   = local.has_dcv ? 1 : 0
  name                    = "${local.prefix}/dcv-sso"
  description             = "HMAC key shared with the DCV workstation agent for browser single sign-on"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "dcv_sso" {
  count         = local.has_dcv ? 1 : 0
  secret_id     = aws_secretsmanager_secret.dcv_sso[0].id
  secret_string = jsonencode({ key = random_password.dcv_sso[0].result })
}

# DCV agent bundle the workstation downloads during "browser connection preparation".
data "archive_file" "dcv_agent" {
  count       = local.has_dcv ? 1 : 0
  type        = "zip"
  source_dir  = "${local.repo_root}/dashboard/dcv-agent"
  output_path = "${path.module}/.context/dcv-agent.zip"
  excludes    = ["__pycache__", "test_activation.py", "test_verifier.py"]
}

resource "aws_s3_object" "dcv_agent" {
  count  = local.has_dcv ? 1 : 0
  bucket = aws_s3_bucket.assets.bucket
  key    = "dcv-agent/${data.archive_file.dcv_agent[0].output_sha256}.zip"
  source = data.archive_file.dcv_agent[0].output_path
  etag   = data.archive_file.dcv_agent[0].output_md5
}

# The workstation instance role (from the Isaac Lab stack) reads the SSO secret and the agent bundle.
data "aws_iam_policy_document" "dcv_host" {
  count = local.has_dcv && lookup(local.isaac_out, "InstanceRoleArn", "") != "" ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.dcv_sso[0].arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.assets.arn}/${aws_s3_object.dcv_agent[0].key}"]
  }
  statement {
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]
  }
}

resource "aws_iam_role_policy" "dcv_host" {
  count  = local.has_dcv && lookup(local.isaac_out, "InstanceRoleArn", "") != "" ? 1 : 0
  name   = "${local.prefix}-dcv-sso"
  role   = element(split("/", local.isaac_out["InstanceRoleArn"]), length(split("/", local.isaac_out["InstanceRoleArn"])) - 1)
  policy = data.aws_iam_policy_document.dcv_host[0].json
}

# Operations source (infra/ops) executed by the CodeBuild operations project.
data "archive_file" "ops_source" {
  type        = "zip"
  source_dir  = "${local.repo_root}/dashboard/infra/ops"
  output_path = "${path.module}/.context/ops-source.zip"
  excludes    = ["__pycache__"]
}

resource "aws_s3_object" "ops_source" {
  bucket = aws_s3_bucket.assets.bucket
  key    = "operations/${data.archive_file.ops_source.output_sha256}.zip"
  source = data.archive_file.ops_source.output_path
  etag   = data.archive_file.ops_source.output_md5
}

# Researcher source-build snapshot (default: the tiny FROM scratch example).
data "archive_file" "source_build_snapshot" {
  type        = "zip"
  source_dir  = var.source_build_directory != "" ? var.source_build_directory : "${local.repo_root}/dashboard/infra/source-build-example"
  output_path = "${path.module}/.context/source-build-snapshot.zip"
  excludes    = [".git", "node_modules", ".venv", "__pycache__", ".next", "dist", "cdk.out", "test-results", "playwright-report"]
}

resource "aws_s3_object" "source_build_snapshot" {
  bucket = aws_s3_bucket.assets.bucket
  key    = "source-builds/${var.source_build_project_id}/${data.archive_file.source_build_snapshot.output_sha256}.zip"
  source = data.archive_file.source_build_snapshot.output_path
  etag   = data.archive_file.source_build_snapshot.output_md5
}
