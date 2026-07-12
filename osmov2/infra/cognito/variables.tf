variable "aws_region" {
  description = "AWS region for the Cognito user pool."
  type        = string
  default     = "ap-northeast-2"
}

variable "name" {
  description = "User pool name. Also used as the hosted UI domain prefix (suffixed with the account ID)."
  type        = string
  default     = "osmo-admin"
}

variable "client_name" {
  description = "App client name used by the OSMO gateway oauth2-proxy."
  type        = string
  default     = "osmo-gateway-oauth2"
}

variable "ui_hostname" {
  description = "Hostname the OSMO UI is served from (CloudFront domain). Used to build the oauth2-proxy callback and logout URLs."
  type        = string
}

variable "deletion_protection" {
  description = "Enable deletion protection on the user pool."
  type        = bool
  default     = false
}

variable "admin_email" {
  description = "Email/username of the initial SSO login user to create in the pool. Leave empty to skip user creation (create users manually with admin-create-user)."
  type        = string
  default     = ""
}

variable "admin_password" {
  description = "Permanent password for the initial SSO login user. Required when admin_email is set. Must satisfy the pool password policy (>=8 chars, upper, lower, number)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
