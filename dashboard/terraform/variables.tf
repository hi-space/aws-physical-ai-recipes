variable "region" {
  description = "AWS region. The workload image inspector and source builds are validated for us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for every named resource (ECS cluster, roles, table, secrets, Cloud Map namespace). Empty = physical-ai-dashboard-<account>, which matches the CDK stack's names."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- public endpoint
variable "domain_name" {
  description = "Public FQDN of the dashboard, e.g. physical-ai.example.com; session hosts live under *.apps.<domain_name>. Empty = no custom domain: the ALB DNS name is used with a self-signed certificate (browser warning) and session-host features are disabled."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone that owns domain_name (required when domain_name is set)."
  type        = string
  default     = ""
}

variable "cognito_domain_prefix" {
  description = "Cognito hosted UI domain prefix (globally unique in the region). Empty = physical-ai-<account>."
  type        = string
  default     = ""
}

variable "admin_username" {
  type    = string
  default = "admin"
}

variable "admin_email" {
  description = "Bootstrap administrator e-mail. Empty = admin@<hosted zone name>."
  type        = string
  default     = ""
}

variable "notify_email" {
  description = "Optional SNS e-mail subscription for dashboard notifications."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- sibling stacks (discovery)
variable "hyperpod_eks_stack_name" {
  description = "CloudFormation stack of the HyperPod EKS cluster (outputs EksClusterName, VpcId, S3BucketName, FsxFileSystemId...). Empty = HyperPodEks-<account>; set to \"-\" to skip discovery."
  type        = string
  default     = ""
}

variable "hyperpod_slurm_stack_name" {
  description = "CloudFormation stack of the HyperPod Slurm cluster. Empty = HyperPod-<account>; \"-\" skips."
  type        = string
  default     = ""
}

variable "groot_stack_name" {
  description = "CloudFormation stack of the GR00T SageMaker recipe. Empty = GrootFinetune-<account>; \"-\" skips."
  type        = string
  default     = ""
}

variable "isaaclab_stack_name" {
  description = "CloudFormation stack of the Isaac Lab / DCV workstation. Empty = IsaacLab-Latest-<account>; \"-\" skips."
  type        = string
  default     = ""
}

variable "vpc_id" {
  description = "Override the VPC (default: VpcId output of the HyperPod EKS stack, then Slurm, then Isaac Lab)."
  type        = string
  default     = ""
}

variable "public_subnet_ids" {
  description = "Override ALB subnets (one per AZ). Default: discovered public subnets of the VPC."
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Override Fargate/CodeBuild subnets (same AZ order as public_subnet_ids). Default: discovered private subnets."
  type        = list(string)
  default     = []
}

variable "eks_cluster_name" {
  description = "Override the EKS cluster name (default: EksClusterName output of the HyperPod EKS stack)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- workloads
variable "extended_images" {
  description = "Also build the GR00T and OpenPI workload images (large; ~30 GB and ~10 GB)."
  type        = bool
  default     = false
}

variable "image_overrides" {
  description = "Skip building an image and use this URI instead. Keys: web, runtime, workspace, mujoco, isaaclab, ros2, groot, openpi. Useful to reuse already published images."
  type        = map(string)
  default     = {}
}

variable "workflow_namespaces" {
  description = "Namespaces that receive the workflow Pod Identity association."
  type        = list(string)
  default     = ["rl", "hyperpod-ns-team-a", "hyperpod-ns-team-b"]
}

variable "workflow_pod_identity_service_account" {
  description = "Service account bound to the workflow pod IAM role via EKS Pod Identity. A namespace/service-account pair can have only one association cluster-wide."
  type        = string
  default     = "pai-workflow"
}

variable "source_build_project_id" {
  description = "Dashboard project that owns the researcher source-build CodeBuild project."
  type        = string
  default     = "workshop"
}

variable "source_build_directory" {
  description = "Local directory snapshotted as the source-build example (default: infra/source-build-example)."
  type        = string
  default     = ""
}

variable "eks_backends" {
  description = "Additional registered EKS backends (EKS_BACKENDS_JSON)."
  type        = list(any)
  default     = []
}

variable "extra_environment" {
  description = "Extra container environment merged last into all three services (e.g. COSMOS_IMAGE_URI)."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------- sizing
variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory_mib" {
  type    = number
  default = 1024
}

variable "controller_cpu" {
  description = "Controller task CPU units. Publication hashes every exported object, so 2 vCPU is the default."
  type        = number
  default     = 2048
}

variable "controller_memory_mib" {
  type    = number
  default = 4096
}

variable "gateway_cpu" {
  type    = number
  default = 256
}

variable "gateway_memory_mib" {
  type    = number
  default = 512
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "cognito_deletion_protection" {
  description = "Protect the user pool from deletion (disable for throwaway validation environments)."
  type        = bool
  default     = true
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager recovery window on destroy (0 = delete immediately; use for validation environments)."
  type        = number
  default     = 30
}

variable "artifact_bucket_force_destroy" {
  description = "Allow terraform destroy to empty the artifact archive (only for throwaway environments)."
  type        = bool
  default     = false
}
