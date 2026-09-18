# Durable state: single-table DynamoDB store, callback ledger, versioned artifact archive, request
# queue with dead letters, notifications topic and the outer run lifecycle state machine
# (mirror of constructs/table.ts and constructs/orchestration.ts).

resource "aws_dynamodb_table" "store" {
  name         = "${local.prefix}-${var.region}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "callbacks" {
  name         = "${local.prefix}-callbacks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = true
  }
}

# ---- artifact archive (pinned snapshots, manifests, checkpoint uploads)
resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${substr(local.prefix, 0, 40)}-artifacts-"
  force_destroy = var.artifact_bucket_force_destroy
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  cors_rule {
    allowed_origins = [local.origin]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "x-amz-version-id", "x-amz-checksum-sha256"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid     = "EnforceTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json
}

# ---- deployment assets (ops source, source-build snapshot, DCV agent) — replaces the CDK asset bucket
resource "aws_s3_bucket" "assets" {
  bucket_prefix = "${substr(local.prefix, 0, 40)}-assets-"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---- queues and notifications
resource "aws_sqs_queue" "dead_letters" {
  name                      = "${local.prefix}-dead-letters"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 14 * 86400
}

resource "aws_sqs_queue" "requests" {
  name                       = "${local.prefix}-requests"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 120
  message_retention_seconds  = 14 * 86400
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letters.arn
    maxReceiveCount     = 5
  })
}

data "aws_iam_policy_document" "queue_policy" {
  for_each = { dead_letters = aws_sqs_queue.dead_letters, requests = aws_sqs_queue.requests }
  statement {
    sid     = "EnforceTLS"
    effect  = "Deny"
    actions = ["sqs:*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    resources = [each.value.arn]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  dynamic "statement" {
    for_each = each.key == "requests" ? [1] : []
    content {
      sid     = "ExecutionStatusEvents"
      effect  = "Allow"
      actions = ["sqs:SendMessage"]
      principals {
        type        = "Service"
        identifiers = ["events.amazonaws.com"]
      }
      resources = [each.value.arn]
      condition {
        test     = "ArnEquals"
        variable = "aws:SourceArn"
        values   = [aws_cloudwatch_event_rule.execution_status.arn]
      }
    }
  }
  dynamic "statement" {
    for_each = each.key == "dead_letters" ? [1] : []
    content {
      sid     = "RedriveFromRequests"
      effect  = "Allow"
      actions = ["sqs:SendMessage"]
      principals {
        type        = "Service"
        identifiers = ["sqs.amazonaws.com"]
      }
      resources = [each.value.arn]
      condition {
        test     = "ArnEquals"
        variable = "aws:SourceArn"
        values   = [aws_sqs_queue.requests.arn]
      }
    }
  }
}

resource "aws_sqs_queue_policy" "queues" {
  for_each  = { dead_letters = aws_sqs_queue.dead_letters, requests = aws_sqs_queue.requests }
  queue_url = each.value.id
  policy    = data.aws_iam_policy_document.queue_policy[each.key].json
}

resource "aws_sns_topic" "notifications" {
  name         = "${local.prefix}-notifications"
  display_name = "Physical AI Dashboard"
}

resource "aws_sns_topic_subscription" "notify_email" {
  count     = var.notify_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "email"
  endpoint  = var.notify_email
}

# ---- outer run lifecycle: dispatch to the worker queue and wait for its callback token
resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/vendedlogs/states/${local.prefix}-workflows"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.prefix}-workflow-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.requests.arn]
  }
  statement {
    actions = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries",
    "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups", "logs:PutLogEvents", "logs:CreateLogStream"]
    resources = ["*"]
  }
  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sfn" {
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

resource "aws_sfn_state_machine" "workflow" {
  name     = "${local.prefix}-workflow"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"
  definition = jsonencode({
    StartAt        = "DispatchWorkflow"
    TimeoutSeconds = 7 * 86400
    States = {
      DispatchWorkflow = {
        Type             = "Task"
        Resource         = "arn:${data.aws_partition.current.partition}:states:::sqs:sendMessage.waitForTaskToken"
        HeartbeatSeconds = 300
        TimeoutSeconds   = 7 * 86400
        ResultPath       = "$.result"
        Parameters = {
          QueueUrl = aws_sqs_queue.requests.url
          MessageBody = {
            kind             = "workflow.start"
            "workflowId.$"   = "$.workflowId"
            "token.$"        = "$$.Task.Token"
            "executionArn.$" = "$$.Execution.Id"
          }
        }
        Next = "Finished"
      }
      Finished = { Type = "Succeed" }
    }
  })
  tracing_configuration {
    enabled = true
  }
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }
  depends_on = [aws_iam_role_policy.sfn]
}

resource "aws_cloudwatch_event_rule" "execution_status" {
  name = "${local.prefix}-execution-status"
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [aws_sfn_state_machine.workflow.arn]
      status          = ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "execution_status" {
  rule = aws_cloudwatch_event_rule.execution_status.name
  arn  = aws_sqs_queue.requests.arn
  input_transformer {
    input_paths    = { executionArn = "$.detail.executionArn", status = "$.detail.status" }
    input_template = <<-EOT
      {"kind":"workflow.execution-ended","executionArn":<executionArn>,"status":<status>}
    EOT
  }
}
