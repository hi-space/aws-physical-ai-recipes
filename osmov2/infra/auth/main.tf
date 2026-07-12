terraform {
  required_version = ">= 1.5.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Mutually exclusive provider selection.
resource "null_resource" "provider_exclusivity" {
  count = (var.deploy_cognito && var.deploy_identity_center) ? "ERROR_only_one_auth_provider_allowed" : 0
}
