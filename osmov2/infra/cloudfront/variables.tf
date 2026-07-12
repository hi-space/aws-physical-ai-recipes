variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "osmo"
}

variable "alb_dns_name" {
  description = "ALB DNS name to use as CloudFront origin."
  type        = string
}

variable "alb_region" {
  description = "AWS region where the ALB resides."
  type        = string
  default     = "ap-northeast-2"
}

variable "allowed_cidrs" {
  description = "CIDR ranges allowed through WAF. Must not include 0.0.0.0/0."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.allowed_cidrs) > 0 && !contains(var.allowed_cidrs, "0.0.0.0/0")
    error_message = "allowed_cidrs must be non-empty and must not include 0.0.0.0/0."
  }
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
