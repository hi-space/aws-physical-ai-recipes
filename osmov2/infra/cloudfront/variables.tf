variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "osmo"
}

variable "osmo_alb_dns_name" {
  description = "OSMO gateway LoadBalancer DNS name (osmo-gateway Service) to use as CloudFront origin. This is the SSO-enabled entrypoint (envoy + oauth2-proxy), not the plain UI ingress."
  type        = string
}

variable "grafana_alb_dns_name" {
  description = "Grafana ALB DNS name to use as CloudFront origin."
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

# `osmo workflow port-forward` relays through the public router address
# (BACKEND.router_address = wss://<cloudfront domain>), and BOTH ends dial it:
# the CLI on the operator's machine and the osmo-ctrl sidecar inside the
# workload pod. The pod egresses via the VPC NAT gateway, so without that IP in
# the allow list CloudFront answers the sidecar with 403 and the sidecar logs
# `userPortForwardTCP: error connecting to the router: websocket: bad handshake`
# while the CLI shows a silent 3-4s reconnect loop that never carries data.
# deploy-osmo-sso-bootstrap.sh reads the EIPs from infra/core and passes them.
variable "cluster_nat_public_ips" {
  description = "Public IPv4 addresses of the VPC NAT gateways, bare (no /prefix). Required for `osmo workflow port-forward`: the in-pod osmo-ctrl sidecar dials the CloudFront router address and is otherwise blocked by the WAF."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = alltrue([for ip in var.cluster_nat_public_ips : can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$", ip))])
    error_message = "cluster_nat_public_ips must be bare IPv4 addresses without a /prefix; the /32 suffix is added automatically."
  }
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
