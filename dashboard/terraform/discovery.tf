# Discovery of the sibling workshop stacks and the shared network, mirroring infra/bin/app.ts.
# Nothing is imported through CloudFormation exports; the dashboard can be created and destroyed
# independently of the clusters.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_route53_zone" "zone" {
  count   = var.domain_name != "" ? 1 : 0
  zone_id = var.hosted_zone_id
}

locals {
  account = data.aws_caller_identity.current.account_id
  prefix  = var.name_prefix != "" ? var.name_prefix : "physical-ai-dashboard-${local.account}"
  # Without a custom domain the dashboard answers on the ALB DNS name (self-signed TLS, no session hosts).
  has_domain = var.domain_name != ""
  domain     = var.domain_name != "" ? var.domain_name : aws_lb.alb.dns_name
  origin     = "https://${var.domain_name != "" ? var.domain_name : aws_lb.alb.dns_name}"

  stack_names = {
    hyperpod_eks   = var.hyperpod_eks_stack_name == "" ? "HyperPodEks-${local.account}" : var.hyperpod_eks_stack_name
    hyperpod_slurm = var.hyperpod_slurm_stack_name == "" ? "HyperPod-${local.account}" : var.hyperpod_slurm_stack_name
    groot          = var.groot_stack_name == "" ? "GrootFinetune-${local.account}" : var.groot_stack_name
    isaaclab       = var.isaaclab_stack_name == "" ? "IsaacLab-Latest-${local.account}" : var.isaaclab_stack_name
  }
  discovered_stacks = { for key, name in local.stack_names : key => name if name != "-" }
}

data "aws_cloudformation_stack" "sibling" {
  for_each = local.discovered_stacks
  name     = each.value
}

locals {
  eks_out   = try(data.aws_cloudformation_stack.sibling["hyperpod_eks"].outputs, {})
  slurm_out = try(data.aws_cloudformation_stack.sibling["hyperpod_slurm"].outputs, {})
  groot_out = try(data.aws_cloudformation_stack.sibling["groot"].outputs, {})
  isaac_out = try(data.aws_cloudformation_stack.sibling["isaaclab"].outputs, {})

  has_eks   = contains(keys(local.eks_out), "EksClusterName") || var.eks_cluster_name != ""
  has_groot = length(local.groot_out) > 0
  has_dcv   = contains(keys(local.isaac_out), "InstanceId")

  eks_cluster_name = var.eks_cluster_name != "" ? var.eks_cluster_name : lookup(local.eks_out, "EksClusterName", "")
  vpc_id           = coalesce(var.vpc_id, lookup(local.eks_out, "VpcId", ""), lookup(local.slurm_out, "VpcId", ""), lookup(local.isaac_out, "VpcId", ""))

  # Buckets the task/controller/pod roles may read and write (discovered data buckets).
  buckets                     = compact([lookup(local.eks_out, "S3BucketName", ""), lookup(local.groot_out, "BucketName", ""), lookup(local.slurm_out, "S3BucketName", "")])
  mlflow_tracking_server_arns = compact([lookup(local.groot_out, "MlflowTrackingServerArn", ""), lookup(local.eks_out, "MlflowTrackingArn", "")])
}

data "aws_vpc" "vpc" {
  id = local.vpc_id
}

data "aws_subnets" "all" {
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_subnet" "all" {
  for_each = toset(data.aws_subnets.all.ids)
  id       = each.value
}

locals {
  # Same classification as app.ts: MapPublicIpOnLaunch or a "public" Name tag → public, the rest private.
  # One subnet per AZ, identical AZ ordering for public and private, AZs limited to the intersection.
  subnet_is_public = { for id, s in data.aws_subnet.all : id => s.map_public_ip_on_launch || can(regex("(?i)public", lookup(s.tags, "Name", ""))) }
  public_by_az     = { for id, s in data.aws_subnet.all : s.availability_zone => id... if local.subnet_is_public[id] }
  private_by_az    = { for id, s in data.aws_subnet.all : s.availability_zone => id... if !local.subnet_is_public[id] }
  common_azs       = sort([for az in keys(local.public_by_az) : az if contains(keys(local.private_by_az), az)])

  public_subnet_ids  = length(var.public_subnet_ids) > 0 ? var.public_subnet_ids : [for az in local.common_azs : sort(local.public_by_az[az])[0]]
  private_subnet_ids = length(var.private_subnet_ids) > 0 ? var.private_subnet_ids : [for az in local.common_azs : sort(local.private_by_az[az])[0]]
}

data "aws_eks_cluster" "cluster" {
  count = local.has_eks ? 1 : 0
  name  = local.eks_cluster_name
}

locals {
  eks_cluster_security_group_id = local.has_eks ? data.aws_eks_cluster.cluster[0].vpc_config[0].cluster_security_group_id : ""
  eks_cluster_arn               = local.has_eks ? data.aws_eks_cluster.cluster[0].arn : ""
}

# Preconditions that app.ts enforces before synthesizing.
resource "terraform_data" "network_preconditions" {
  lifecycle {
    precondition {
      condition     = length(local.public_subnet_ids) >= 2
      error_message = "The VPC needs at least two public subnets (in different AZs) for the ALB."
    }
    precondition {
      condition     = length(local.private_subnet_ids) >= 1 && length(local.private_subnet_ids) == length(local.public_subnet_ids)
      error_message = "Private subnets must cover the same AZs as the public subnets (one per AZ)."
    }
  }
}
