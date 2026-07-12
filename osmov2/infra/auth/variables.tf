variable "aws_region" {
  description = "AWS region for the auth resources."
  type        = string
  default     = "ap-northeast-2"
}

variable "name_prefix" {
  description = "Prefix for auth resource names (e.g. aws-osmo-dev-repro)."
  type        = string
}

variable "deploy_cognito" {
  description = "Provision a Cognito user pool as the OSMO IdP."
  type        = bool
  default     = false
}

variable "deploy_identity_center" {
  description = "Provision an IAM Identity Center OAuth2 application as the OSMO IdP."
  type        = bool
  default     = false
}

variable "osmo_hostname" {
  description = "FQDN of the OSMO gateway (ALB), e.g. osmo.example.com. Used for OAuth callback URLs."
  type        = string
  default     = ""
}

variable "osmo_auth_hostname" {
  description = "FQDN for the Cognito hosted UI custom domain, e.g. osmo-auth.example.com."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID owning the hostnames."
  type        = string
  default     = ""
}

variable "common_tags" {
  description = "Tags applied to auth resources."
  type        = map(string)
  default     = {}
}
