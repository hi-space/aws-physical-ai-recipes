variable "aws_region" {
  description = "AWS region for the reference deployment."
  type        = string
  default     = "ap-northeast-2"
}

variable "project_name" {
  description = "Project name used for AWS resource names."
  type        = string
  default     = "aws-osmo"
}

variable "environment" {
  description = "Environment name. Defaults are optimized for reproducible reference deployments."
  type        = string
  default     = "dev-repro"

  validation {
    condition     = contains(["dev-repro", "reference-ha"], var.environment)
    error_message = "environment must be dev-repro or reference-ha."
  }
}

variable "tags" {
  description = "Additional tags applied to all taggable resources."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "Explicit ordered list of availability zones to place subnets in. Empty uses the first discovered AZs. Set this to pin capacity-constrained instance families (for example G7e is only offered in ap-northeast-2a and ap-northeast-2b in Seoul)."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) >= 2
    error_message = "availability_zones must be empty or contain at least 2 zones."
  }
}

variable "az_count" {
  description = "Number of availability zones used by EKS and stateful backing services."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "karpenter_az_count" {
  description = "Number of availability zones with Karpenter-discoverable private subnets for GPU capacity."
  type        = number
  default     = 4

  validation {
    condition     = var.karpenter_az_count >= 2 && var.karpenter_az_count <= 4
    error_message = "karpenter_az_count must be between 2 and 4."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway for the reference deployment. Set false for AZ-aligned HA."
  type        = bool
  default     = true
}

variable "eks_cluster_version" {
  description = "EKS Kubernetes version. Keep this on a current standard-support version."
  type        = string
  default     = "1.35"

  validation {
    condition     = contains(["1.34", "1.35"], var.eks_cluster_version)
    error_message = "Use a current standard-support EKS version. This repo intentionally does not default to older EKS releases."
  }
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "Optional CIDR allow list for public EKS API endpoint access. Empty keeps the endpoint private only."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.cluster_endpoint_public_access_cidrs, "0.0.0.0/0")
    error_message = "Do not expose the EKS API endpoint to 0.0.0.0/0."
  }
}

variable "system_node_instance_types" {
  description = "Instance types for the non-GPU OSMO system node group."
  type        = list(string)
  default     = ["m7i.2xlarge"]
}

variable "system_node_min_size" {
  description = "Minimum number of system nodes."
  type        = number
  default     = 3
}

variable "system_node_desired_size" {
  description = "Desired number of system nodes."
  type        = number
  default     = 3
}

variable "system_node_max_size" {
  description = "Maximum number of system nodes."
  type        = number
  default     = 5
}

variable "reference_ha" {
  description = "Enable HA-oriented defaults for selected backing services."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Enable deletion protection for stateful services. Keep false for clean-account reproducibility tests."
  type        = bool
  default     = false
}

variable "postgres_engine_version" {
  description = "PostgreSQL engine version."
  type        = string
  default     = "16.6"
}

variable "postgres_family" {
  description = "PostgreSQL parameter group family."
  type        = string
  default     = "postgres16"
}

variable "postgres_major_engine_version" {
  description = "PostgreSQL major engine version."
  type        = string
  default     = "16"
}

variable "postgres_instance_class" {
  description = "RDS instance class for PostgreSQL."
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_allocated_storage" {
  description = "Initial PostgreSQL allocated storage in GiB."
  type        = number
  default     = 50
}

variable "postgres_max_allocated_storage" {
  description = "Maximum PostgreSQL allocated storage in GiB."
  type        = number
  default     = 200
}

variable "postgres_database_name" {
  description = "OSMO PostgreSQL database name."
  type        = string
  default     = "osmo"
}

variable "postgres_username" {
  description = "OSMO PostgreSQL username."
  type        = string
  default     = "osmo"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis engine version."
  type        = string
  default     = "7.1"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_nodes" {
  description = "Number of Redis cache nodes. Use 1 for reproducible dev; use 2 or more for HA."
  type        = number
  default     = 1

  validation {
    condition     = var.redis_num_cache_nodes == 1 || var.redis_num_cache_nodes >= 2
    error_message = "redis_num_cache_nodes must be 1 or at least 2."
  }
}

variable "ecr_force_delete" {
  description = "Allow Terraform destroy to delete the workload ECR repository when it contains images."
  type        = bool
  default     = true
}

variable "s3_force_destroy" {
  description = "Allow Terraform destroy to delete workflow artifacts in the S3 bucket. Keep true for clean-account reproducibility tests."
  type        = bool
  default     = true
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window. Zero is allowed for ephemeral test accounts."
  type        = number
  default     = 0
}

variable "osmo_namespace" {
  description = "Kubernetes namespace for OSMO services."
  type        = string
  default     = "osmo"
}

variable "osmo_workload_namespace" {
  description = "Kubernetes namespace for OSMO workflow pods."
  type        = string
  default     = "osmo-workflows"
}

variable "osmo_service_account_name" {
  description = "Kubernetes service account used by OSMO services."
  type        = string
  default     = "osmo"
}

variable "gpu_provisioner" {
  description = "GPU node provisioner. karpenter (dynamic, default) or managed-nodegroup (EKS managed node group + Cluster Autoscaler)."
  type        = string
  default     = "karpenter"

  validation {
    condition     = contains(["karpenter", "managed-nodegroup"], var.gpu_provisioner)
    error_message = "gpu_provisioner must be karpenter or managed-nodegroup."
  }
}

variable "gpu_capacity_type" {
  description = "Capacity type for the managed GPU node group. ON_DEMAND (default, reproducible) or SPOT."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.gpu_capacity_type)
    error_message = "gpu_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "gpu_managed_node_instance_types" {
  description = "Instance types for the managed GPU node group (managed-nodegroup provisioner only)."
  type        = list(string)
  default     = ["g6.2xlarge"]
}

variable "gpu_managed_node_min_size" {
  description = "Minimum managed GPU nodes. Zero enables scale-to-zero via Cluster Autoscaler."
  type        = number
  default     = 0
}

variable "gpu_managed_node_desired_size" {
  description = "Desired managed GPU nodes."
  type        = number
  default     = 0
}

variable "gpu_managed_node_max_size" {
  description = "Maximum managed GPU nodes."
  type        = number
  default     = 4
}
