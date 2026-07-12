# IAM Identity Center customer-managed OAuth2 application for OSMO.
# NOTE: the OAuth client_secret must be generated MANUALLY in the Identity
# Center console after `terraform apply` (AWS API does not expose it).

data "aws_ssoadmin_instances" "this" {
  count = var.deploy_identity_center ? 1 : 0
}

locals {
  idc_instance_arn = var.deploy_identity_center ? tolist(data.aws_ssoadmin_instances.this[0].arns)[0] : ""
  idc_issuer       = var.deploy_identity_center && var.osmo_auth_hostname != "" ? "https://${var.osmo_auth_hostname}" : ""
}

resource "aws_ssoadmin_application" "osmo" {
  count = var.deploy_identity_center ? 1 : 0

  name                     = "${var.name_prefix}-osmo"
  instance_arn             = local.idc_instance_arn
  application_provider_arn = "arn:aws:sso::aws:applicationProvider/custom"
  description              = "OSMO on AWS - OAuth 2.0 OIDC provider"
  status                   = "ENABLED"

  portal_options {
    visibility = "ENABLED"

    sign_in_options {
      origin = var.osmo_hostname != "" ? "https://${var.osmo_hostname}" : ""
    }
  }
}
