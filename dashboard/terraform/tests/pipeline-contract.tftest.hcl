# Local plans only: all providers are mocked, including external image staging.
# Assertions inspect evaluated environment inputs and IAM statements, not source text.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "913524902871" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_route53_zone" {
    defaults = { name = "example.com" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = [] }
  }
  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.0.0.0/16" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn                       = "arn:aws:acm:us-east-1:913524902871:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = []
    }
  }
  mock_data "aws_cloudformation_stack" {
    defaults = {
      outputs = {
        BucketName            = "groot-artifacts-913524902871"
        SageMakerRoleArn      = "arn:aws:iam::913524902871:role/groot-sagemaker"
        TrainingRepositoryUri = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-training"
      }
    }
  }
}

mock_provider "random" {
  override_during = plan
}
mock_provider "archive" {
  override_during = plan
}
mock_provider "external" {
  override_during = plan
  mock_data "external" {
    defaults = {
      result = {
        hash    = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        context = "mock-workload-context"
      }
    }
  }
}

# The environment filters out empty values, so every input to that filter must
# be known during plan. Override only upstream resource attributes; keep the
# environment expressions and IAM statements under test intact.
override_resource {
  target          = aws_sns_topic.notifications
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:913524902871:pipeline-test-notifications"
  }
}

override_resource {
  target          = aws_sfn_state_machine.workflow
  override_during = plan
  values = {
    arn = "arn:aws:states:us-east-1:913524902871:stateMachine:pipeline-test-workflow"
  }
}

override_resource {
  target          = aws_sqs_queue.requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:913524902871:pipeline-test-requests"
    url = "https://sqs.us-east-1.amazonaws.com/913524902871/pipeline-test-requests"
  }
}

override_resource {
  target          = aws_s3_bucket.artifacts
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::pipeline-test-artifacts"
    bucket = "pipeline-test-artifacts"
    id     = "pipeline-test-artifacts"
  }
}

override_resource {
  target          = aws_s3_bucket.assets
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::pipeline-test-assets"
    bucket = "pipeline-test-assets"
    id     = "pipeline-test-assets"
  }
}

override_resource {
  target          = aws_iam_role.source_build
  override_during = plan
  values = {
    arn = "arn:aws:iam::913524902871:role/pipeline-test-source-build"
  }
}

variables {
  name_prefix               = "pipeline-test"
  domain_name               = "dashboard.example.com"
  hosted_zone_id            = "Z0123456789ABCDEF"
  hyperpod_eks_stack_name   = "-"
  hyperpod_slurm_stack_name = "-"
  isaaclab_stack_name       = "-"
  vpc_id                    = "vpc-0123456789abcdef0"
  public_subnet_ids         = ["subnet-00000000000000001", "subnet-00000000000000002"]
  private_subnet_ids        = ["subnet-00000000000000003", "subnet-00000000000000004"]
  # Known image inputs also omit every local-exec image build from these plans.
  image_overrides = {
    web       = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/web:test"
    runtime   = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/runtime:test"
    workspace = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/workspace:test"
    mujoco    = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/mujoco:test"
    isaaclab  = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/isaaclab:test"
    ros2      = "913524902871.dkr.ecr.us-east-1.amazonaws.com/mock/ros2:test"
  }
}

run "custom_pipeline_output" {
  command = plan

  override_data {
    target = data.aws_cloudformation_stack.sibling["groot"]
    values = {
      outputs = {
        PipelineName          = "research-gr00t-custom"
        BucketName            = "groot-artifacts-913524902871"
        SageMakerRoleArn      = "arn:aws:iam::913524902871:role/groot-sagemaker"
        TrainingRepositoryUri = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-training"
      }
    }
  }

  assert {
    condition     = local.web_env.SM_PIPELINE_NAME == "research-gr00t-custom" && local.controller_env.SM_PIPELINE_NAME == "research-gr00t-custom"
    error_message = "Web and controller must receive the explicit custom pipeline name."
  }

  assert {
    condition = alltrue([
      for statements in [data.aws_iam_policy_document.web.statement, data.aws_iam_policy_document.controller.statement] :
      length([for statement in statements : statement if contains(statement.actions, "sagemaker:StartPipelineExecution")]) == 1 &&
      alltrue([for statement in statements : statement.resources == toset(["arn:aws:sagemaker:us-east-1:913524902871:pipeline/research-gr00t-custom"])
      if contains(statement.actions, "sagemaker:StartPipelineExecution")])
    ])
    error_message = "Both roles must start only the explicit custom pipeline."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.groot_evidence[0].statement :
      statement.resources == toset([
        "arn:aws:sagemaker:us-east-1:913524902871:pipeline/research-gr00t-custom",
        "arn:aws:sagemaker:us-east-1:913524902871:pipeline/research-gr00t-custom/execution/*",
      ]) if contains(statement.actions, "sagemaker:DescribePipeline")
    ])
    error_message = "Shared evidence permissions must follow the custom pipeline."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.web.statement :
      statement.resources == toset(["arn:aws:sagemaker:us-east-1:913524902871:pipeline/research-gr00t-custom/execution/*"])
      if contains(statement.actions, "sagemaker:StopPipelineExecution")
    ])
    error_message = "Web cancellation must stay within the configured pipeline executions."
  }
}

run "missing_pipeline_output" {
  command = plan

  assert {
    condition     = local.web_env.SM_PIPELINE_NAME == "groot-sm-finetuning-913524902871" && local.controller_env.SM_PIPELINE_NAME == "groot-sm-finetuning-913524902871"
    error_message = "Web and controller must receive the fallback pipeline name."
  }

  assert {
    condition = alltrue([
      for statements in [data.aws_iam_policy_document.web.statement, data.aws_iam_policy_document.controller.statement] :
      length([for statement in statements : statement if contains(statement.actions, "sagemaker:StartPipelineExecution")]) == 1 &&
      alltrue([for statement in statements : statement.resources == toset(["arn:aws:sagemaker:us-east-1:913524902871:pipeline/groot-sm-finetuning-913524902871"])
      if contains(statement.actions, "sagemaker:StartPipelineExecution")])
    ])
    error_message = "Both roles must start only the fallback pipeline."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.groot_evidence[0].statement :
      statement.resources == toset([
        "arn:aws:sagemaker:us-east-1:913524902871:pipeline/groot-sm-finetuning-913524902871",
        "arn:aws:sagemaker:us-east-1:913524902871:pipeline/groot-sm-finetuning-913524902871/execution/*",
      ]) if contains(statement.actions, "sagemaker:DescribePipeline")
    ])
    error_message = "Shared evidence permissions must use the fallback pipeline."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.groot_evidence[0].statement :
      statement.resources == toset(["arn:aws:iam::913524902871:role/groot-sagemaker"]) &&
      one(statement.condition).test == "StringEquals" &&
      one(statement.condition).variable == "iam:PassedToService" &&
      one(one(statement.condition).values) == "sagemaker.amazonaws.com"
      if contains(statement.actions, "iam:PassRole")
    ])
    error_message = "PassRole must retain the discovered role and SageMaker service condition."
  }
}

run "absent_groot_stack" {
  command = plan
  variables {
    groot_stack_name = "-"
  }

  assert {
    condition     = !contains(keys(local.web_env), "SM_PIPELINE_NAME") && !contains(keys(local.controller_env), "SM_PIPELINE_NAME")
    error_message = "No pipeline environment should be emitted without a GR00T stack."
  }

  assert {
    condition = alltrue([
      for statements in [data.aws_iam_policy_document.web.statement, data.aws_iam_policy_document.controller.statement] :
      alltrue([for statement in statements : !contains(statement.actions, "sagemaker:StartPipelineExecution")])
    ]) && length(data.aws_iam_policy_document.groot_evidence) == 0
    error_message = "No pipeline grants should be emitted without a GR00T stack."
  }
}

run "explicit_environment_pipeline" {
  command = plan
  variables {
    extra_environment = { SM_PIPELINE_NAME = "override-pipeline" }
  }

  override_data {
    target = data.aws_cloudformation_stack.sibling["groot"]
    values = {
      outputs = {
        PipelineName          = "research-gr00t-custom"
        BucketName            = "groot-artifacts-913524902871"
        SageMakerRoleArn      = "arn:aws:iam::913524902871:role/groot-sagemaker"
        TrainingRepositoryUri = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-training"
      }
    }
  }

  assert {
    condition     = local.web_env.SM_PIPELINE_NAME == "override-pipeline" && local.controller_env.SM_PIPELINE_NAME == "override-pipeline"
    error_message = "Both final service environments must use the explicitly configured pipeline."
  }

  assert {
    condition = alltrue([
      for statements in [data.aws_iam_policy_document.web.statement, data.aws_iam_policy_document.controller.statement] :
      length([for statement in statements : statement if contains(statement.actions, "sagemaker:StartPipelineExecution")]) == 1 &&
      alltrue([for statement in statements : statement.resources == toset(["arn:aws:sagemaker:us-east-1:913524902871:pipeline/override-pipeline"])
      if contains(statement.actions, "sagemaker:StartPipelineExecution")])
    ])
    error_message = "Environment overrides must also govern both execution policies."
  }

  assert {
    condition = length([
      for statement in data.aws_iam_policy_document.web.statement : statement
      if contains(statement.actions, "sagemaker:StopPipelineExecution")
      ]) == 1 && alltrue([
      for statement in data.aws_iam_policy_document.web.statement :
      statement.resources == toset(["arn:aws:sagemaker:us-east-1:913524902871:pipeline/override-pipeline/execution/*"])
      if contains(statement.actions, "sagemaker:StopPipelineExecution")
    ])
    error_message = "Cancellation must use executions of the environment override."
  }

  assert {
    condition = alltrue([
      for action in [
        "sagemaker:DescribePipeline", "sagemaker:ListPipelineExecutions",
        "sagemaker:DescribePipelineExecution", "sagemaker:DescribePipelineDefinitionForExecution",
        "sagemaker:ListPipelineExecutionSteps", "sagemaker:ListPipelineParametersForExecution",
        ] : length([
          for statement in data.aws_iam_policy_document.groot_evidence[0].statement : statement
          if contains(statement.actions, action)
          ]) == 1 && alltrue([
          for statement in data.aws_iam_policy_document.groot_evidence[0].statement :
          statement.resources == toset([
            "arn:aws:sagemaker:us-east-1:913524902871:pipeline/override-pipeline",
            "arn:aws:sagemaker:us-east-1:913524902871:pipeline/override-pipeline/execution/*",
          ]) if contains(statement.actions, action)
      ])
    ])
    error_message = "Every pipeline evidence action must use the environment override."
  }
}
